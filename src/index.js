const fs = require('node:fs');
const path = require('node:path');

const actions = require('@actions/core');
const { Glob } = require('glob');
const { google } = require('googleapis');

/**
 * Global static reference to the Google Drive API
 *
 * @type {import('googleapis').drive_v3.Drive}
 */
let DRIVE;

/**
 * Maximum number of retry attempts for API operations
 */
const MAX_RETRIES = 3;

/**
 * Base delay for exponential backoff (in milliseconds)
 */
const BASE_RETRY_DELAY = 1000;

/**
 * Valid replace modes for handling existing files
 */
const REPLACE_MODES = {
    DELETE_FIRST: 'delete_first',
    UPDATE_IN_PLACE: 'update_in_place',
    ADD_NEW: 'add_new',
};

/**
 * MIME type mapping for Google Drive conversion
 */
const MIMETYPE_MAP = {
    '.case': 'application/vnd.google-apps.spreadsheet', // Special case handling if needed
    '.csv': 'application/vnd.google-apps.spreadsheet',
    '.xlsx': 'application/vnd.google-apps.spreadsheet',
    '.xls': 'application/vnd.google-apps.spreadsheet',
    '.ods': 'application/vnd.google-apps.spreadsheet',
    '.md': 'application/vnd.google-apps.document',
    '.txt': 'application/vnd.google-apps.document',
    '.docx': 'application/vnd.google-apps.document',
    '.doc': 'application/vnd.google-apps.document',
    '.html': 'application/vnd.google-apps.document',
    '.pptx': 'application/vnd.google-apps.presentation',
    '.ppt': 'application/vnd.google-apps.presentation',
};

/**
 * Get input value and log value to debug
 *
 * @param {string} name
 * @param {actions.InputOptions | undefined} options
 * @returns {string}
 */
function getInputAndDebug(name, options) {
    const val = actions.getInput(name, options);

    actions.debug(`${name}: ${val}`);
    return val;
}

/**
 * Get input value and log value to debug
 *
 * @param {string} name
 * @param {actions.InputOptions | undefined} options
 * @returns {boolean}
 */
function getBooleanInputAndDebug(name, options) {
    const val = actions.getBooleanInput(name, options);

    actions.debug(`${name}: ${val}`);
    return val;
}

/**
 * Sleep for a specified number of milliseconds
 * 
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute a function with retry logic
 * 
 * @template T
 * @param {function(): Promise<T>} fn - Function to execute
 * @param {string} operationName - Name of the operation for logging
 * @param {number} [maxRetries=MAX_RETRIES] - Maximum number of retry attempts
 * @param {number} [baseDelay=BASE_RETRY_DELAY] - Base delay for exponential backoff
 * @returns {Promise<T>}
 */
async function withRetry(fn, operationName, maxRetries = MAX_RETRIES, baseDelay = BASE_RETRY_DELAY) {
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;

            if (attempt < maxRetries) {
                const delay = baseDelay * Math.pow(2, attempt - 1);
                console.log(`${operationName} failed (attempt ${attempt}/${maxRetries}). Retrying in ${delay}ms...`);
                actions.warning(`${operationName} failed: ${error.message}. Retrying...`);
                await sleep(delay);
            }
        }
    }

    throw new Error(`${operationName} failed after ${maxRetries} attempts: ${lastError.message}`);
}

/**
 * Validates and parses the credentials
 * 
 * @param {string} credentials - Base64 encoded or plain JSON credentials
 * @returns {object} Parsed credentials object
 * @throws {Error} If the credentials are invalid
 */
function parseCredentials(credentials) {
    try {
        // First try to parse as plain JSON
        const parsed = JSON.parse(credentials);
        if (parsed.client_email && parsed.private_key) {
            return parsed;
        }
    } catch {
        // If JSON parse fails, it might be base64
    }

    try {
        // Try decoding from Base64
        const decoded = Buffer.from(credentials, 'base64').toString();
        const parsed = JSON.parse(decoded);

        if (!parsed.client_email || !parsed.private_key) {
            throw new Error('Missing required fields in credentials');
        }
        return parsed;
    } catch (error) {
        throw new Error(`Invalid credentials format: ${error.message}`);
    }
}

/**
 * Grant file permissions to a list of emails
 *
 * @param {object} drive - Google Drive API instance
 * @param {string} fileId - ID of the file to share
 * @param {string} emailList - Comma-separated list of emails
 * @param {boolean} sendNotification - Whether to send email notification
 * @returns {Promise<void>}
 */
async function grantPermissions(drive, fileId, emailList, sendNotification = false) {
    if (!emailList || typeof emailList !== 'string') {
        return;
    }

    const emails = emailList.split(',').map(e => e.trim()).filter(e => e.length > 0);

    if (emails.length === 0) {
        return;
    }

    console.log(`Sharing file ${fileId} with ${emails.length} users (Notification: ${sendNotification})...`);

    for (const email of emails) {
        try {
            await drive.permissions.create({
                fileId,
                requestBody: {
                    role: 'reader',
                    type: 'user',
                    emailAddress: email
                },
                supportsAllDrives: true,
                sendNotificationEmail: sendNotification
            });
            console.log(`Granted 'reader' access to ${email}`);
        } catch (error) {
            console.error(`Failed to share with ${email}: ${error.message}`);
            actions.warning(`Failed to share with ${email}: ${error.message}`);
        }
    }
}

/**
 * Generate description with GitHub context
 * 
 * @returns {string}
 */
function getMetadataDescription() {
    const repo = process.env.GITHUB_REPOSITORY || 'unknown';
    const sha = process.env.GITHUB_SHA || 'unknown';
    const server = process.env.GITHUB_SERVER_URL || 'https://github.com';
    const runId = process.env.GITHUB_RUN_ID || '';
    const ref = process.env.GITHUB_REF_NAME || 'unknown';

    const runLink = runId ? `${server}/${repo}/actions/runs/${runId}` : 'N/A';

    return 'Uploaded via GitHub Actions\n'
        + `Repo: ${repo}\n`
        + `Branch/Tag: ${ref}\n`
        + `Commit: ${sha.substring(0, 7)}\n`
        + `Run: ${runLink}`;
}

/**
 * Validates that the input file or pattern exists
 * 
 * @param {string} target - File path or glob pattern
 * @throws {Error} If the target doesn't exist
 */
function validateTarget(target) {
    if (target.includes('*')) {
        // For glob patterns, we'll check if any files match during processing
        return;
    }

    const resolvedPath = path.resolve(target);
    if (!fs.existsSync(resolvedPath)) {
        throw new Error(`Target file not found: ${resolvedPath}`);
    }
}

/**
 * Splits off the top level folder and returns a tuple of [head, rest]
 *
 * @example
 * // returns ['home', 'user/.config']
 * splitFolder('home/user/.config')
 * @example
 * // returns ['.config', null]
 * splitFolder('.config')
 * @param {string} folder
 * @returns {[string, string | null]}
 */
function splitFolder(folder) {
    if (folder.includes('/')) {
        const indexOfDelimiter = folder.indexOf('/');
        const currentFolder = folder.substring(0, indexOfDelimiter);
        const currentChild = folder.substring(indexOfDelimiter + 1);

        return [currentFolder, currentChild];
    } else {
        return [folder, null];
    }
}

/**
 * Return the id of the child folder and create the directories if they are missing
 *
 * @param {string} parentFolderId Id of the parent directory
 * @param {string | null} childFolderPath
 * @returns {Promise<string>}
 */
async function getUploadFolderId(parentFolderId, childFolderPath) {
    actions.debug(`parentFolderId: ${parentFolderId}`);
    actions.debug(`childFolderPath: ${childFolderPath}`);
    if (!childFolderPath) {
        // Empty or null: return parent id
        return parentFolderId;
    }

    const [currentFolder, remainingFolderPath] = splitFolder(childFolderPath);

    actions.debug(`currentFolder: ${currentFolder}`);
    actions.debug(`remainingFolderPath: ${remainingFolderPath}`);

    // Check if child folder already exists and is unique
    const listFilesOperation = async () => {
        return DRIVE.files.list({
            q: `name='${currentFolder}' and '${parentFolderId}' in parents and trashed=false`,
            fields: 'files(id)',
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
        });
    };

    const {
        data: { files },
    } = await withRetry(listFilesOperation, `List files in folder ${parentFolderId}`);

    actions.debug(`files: ${JSON.stringify(files)}`);

    if (files.length > 1) {
        throw new Error(`More than one folder named '${currentFolder}' found in parent folder ${parentFolderId}`);
    }
    if (files.length === 1) {
        actions.debug(`${currentFolder} exists inside ${parentFolderId}`);
        // Folder exists, check that folders children
        return getUploadFolderId(files[0].id, remainingFolderPath);
    }

    actions.debug(`${currentFolder} does not exist inside ${parentFolderId}`);
    console.log(`Creating folder '${currentFolder}'...`);

    const currentFolderMetadata = {
        name: currentFolder,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentFolderId],
    };

    const createFolderOperation = async () => {
        return DRIVE.files.create({
            requestBody: currentFolderMetadata,
            fields: 'id',
            supportsAllDrives: true,
        });
    };

    const {
        data: { id: currentFolderId },
    } = await withRetry(createFolderOperation, `Create folder ${currentFolder}`);

    actions.debug(`${currentFolder} id: ${currentFolderId}`);
    console.log(`Folder '${currentFolder}' created successfully.`);

    return getUploadFolderId(currentFolderId, remainingFolderPath);
}

/**
 * Validates the replace mode
 * 
 * @param {string} replaceMode - The replace mode to validate
 * @returns {string} The validated replace mode
 * @throws {Error} If the replace mode is invalid
 */
function validateReplaceMode(replaceMode) {
    const mode = replaceMode.toLowerCase();
    const validModes = Object.values(REPLACE_MODES);

    if (!validModes.includes(mode)) {
        throw new Error(`Invalid replace_mode: ${replaceMode}. Valid options are: ${validModes.join(', ')}`);
    }

    return mode;
}

/**
 * Find existing files with the same name in the target folder
 * 
 * @param {string} fileName - Name of the file to search for
 * @param {string} uploadFolderId - ID of the folder to search in
 * @returns {Promise<Array<{id: string, name: string}>>} - Array of matching files
 */
async function findExistingFiles(fileName, uploadFolderId) {
    const listFilesOperation = async () => {
        return DRIVE.files.list({
            q: `'${uploadFolderId}' in parents and name='${fileName}' and trashed=false`,
            fields: 'nextPageToken, files(id, name, webViewLink)',
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
        });
    };

    const { data: { files } } = await withRetry(
        listFilesOperation,
        `List files in folder ${uploadFolderId} with name ${fileName}`
    );

    return files;
}

/**
 * Delete an existing file
 * 
 * @param {object} drive - Google Drive API instance
 * @param {string} fileId - ID of the file to delete
 * @param {string} fileName - Name of the file (for logging)
 * @returns {Promise<void>}
 */
async function deleteFile(drive, fileId, fileName) {
    console.log(`Found existing file '${fileName}'. Removing...`);
    actions.debug(`Removing ${fileName}(${fileId})`);

    const deleteFileOperation = async () => {
        return drive.files.delete({
            fileId,
            supportsAllDrives: true,
        });
    };

    await withRetry(deleteFileOperation, `Delete file ${fileName} (${fileId})`);
    console.log(`Existing file '${fileName}' removed successfully.`);
}

/**
 * Update an existing file with new content
 * 
 * @param {string} fileId - ID of the file to update
 * @param {string} fileName - Name of the file
 * @param {string} filePath - Path to the new file content
 * @param {string} shareWith - Emails to share with
 * @param {string} description - File description
 * @param {boolean} sendNotification - Whether to send share notification
 * @returns {Promise<import('googleapis').drive_v3.Schema$File>} - Updated file data
 */
async function updateFile(fileId, fileName, filePath, shareWith = '', description = '', sendNotification = false) {
    console.log(`Found existing file '${fileName}'. Updating in place...`);
    actions.debug(`Updating ${fileName}(${fileId})`);

    const stats = fs.statSync(filePath);
    const fileSize = stats.size;
    const isResumable = fileSize > 5 * 1024 * 1024; // 5MB

    if (isResumable) {
        console.log(`File size: ${(fileSize / (1024 * 1024)).toFixed(2)} MB. Using Resumable Upload.`);
    } else {
        console.log(`File size: ${(fileSize / (1024 * 1024)).toFixed(2)} MB. Using Multipart Upload.`);
    }

    const fileData = {
        body: fs.createReadStream(filePath),
    };

    // If description is provided, we need to update it as well
    const requestBody = {};
    if (description) {
        requestBody.description = description;
    }

    const updateFileOperation = async () => {
        return DRIVE.files.update({
            fileId,
            requestBody: description ? requestBody : undefined,
            media: fileData,
            uploadType: isResumable ? 'resumable' : 'multipart',
            fields: 'id,name,webViewLink',
            supportsAllDrives: true,
        });
    };

    const result = await withRetry(updateFileOperation, `Update file ${fileName}`);
    console.log(`File '${fileName}' updated successfully. ID: ${result.data.id}`);

    if (result.data.webViewLink) {
        console.log(`View file: ${result.data.webViewLink}`);
    }

    if (shareWith) {
        await grantPermissions(DRIVE, result.data.id, shareWith, sendNotification);
    }

    return result.data;
}

/**
 * Helper to get upload parameters + logging
 * 
 * @param {object} fileMetadata 
 * @param {string} filePath 
 * @param {boolean} convertFiles
 * @param {string} description
 * @returns {object}
 */
function getUploadParams(fileMetadata, filePath, convertFiles = false, description = '') {
    const stats = fs.statSync(filePath);
    const fileSize = stats.size;
    // Switch to resumable upload if file size > 5MB
    const isResumable = fileSize > 5 * 1024 * 1024;

    if (isResumable) {
        console.log(`File size: ${(fileSize / (1024 * 1024)).toFixed(2)} MB. Using Resumable Upload.`);
    } else {
        console.log(`File size: ${(fileSize / (1024 * 1024)).toFixed(2)} MB. Using Multipart Upload.`);
    }

    // Create a copy of fileMetadata to avoid mutating the original
    const body = { ...fileMetadata };

    // Handle file conversion
    if (convertFiles) {
        const ext = path.extname(filePath).toLowerCase();
        if (MIMETYPE_MAP[ext]) {
            body.mimeType = MIMETYPE_MAP[ext];
            console.log(`Converting '${ext}' file to Google format: ${MIMETYPE_MAP[ext]}`);
        }
    }

    // Add description if provided
    if (description) {
        body.description = description;
    }

    return {
        requestBody: body,
        media: {
            body: fs.createReadStream(filePath)
        },
        uploadType: isResumable ? 'resumable' : 'multipart',
        fields: 'id,name,webViewLink',
        supportsAllDrives: true,
    };
}

/**
 *  Uploads a file from the filesystem
 *
 * @param {string} fileName Name to use in Google Drive
 * @param {string} filePath Path to the file on the filesystem
 * @param {string} replaceMode How to handle existing files with the same name
 * @param {boolean} override Whether or not to remove and replace the current file if it exists (legacy parameter)
 * @param {string} uploadFolderId Id of the new files parent
 * @param {boolean} convertFiles Whether to convert files to Google formats
 * @param {string} shareWith Comma-separated list of emails to share with
 * @param {string} description content to add to file description
 * @returns {Promise<import('googleapis').drive_v3.Schema$File>}
 *          Response from the google drive files create api
 */
async function uploadFile(
    fileName,
    filePath,
    replaceMode,
    override,
    uploadFolderId,
    convertFiles = false,
    shareWith = '',
    description = '',
    sendNotification = false
) {
    console.log(`Processing ${fileName} ...`);
    actions.debug(`fileName: ${fileName}`);
    actions.debug(`filePath: ${filePath}`);
    actions.debug(`replaceMode: ${replaceMode}`);
    actions.debug(`override: ${override}`);
    actions.debug(`uploadFolderId: ${uploadFolderId}`);

    // Validate file exists and is readable
    try {
        await fs.promises.access(filePath, fs.constants.R_OK);
    } catch (error) {
        throw new Error(`Cannot access file ${filePath}: ${error.message}`);
    }

    const fileStats = await fs.promises.stat(filePath);
    console.log(`File size: ${(fileStats.size / 1024 / 1024).toFixed(2)} MB`);

    // For backward compatibility, if override is true, use DELETE_FIRST mode
    let effectiveReplaceMode = replaceMode;
    if (override === true && replaceMode === REPLACE_MODES.ADD_NEW) {
        console.log('Override parameter is set to true, using delete_first replace mode');
        effectiveReplaceMode = REPLACE_MODES.DELETE_FIRST;
    }

    // Find existing files with the same name
    const existingFiles = await findExistingFiles(fileName, uploadFolderId);

    // Handle existing files based on replace mode
    if (existingFiles.length > 0) {
        if (effectiveReplaceMode === REPLACE_MODES.DELETE_FIRST) {
            // Delete all existing files with the same name
            for (const file of existingFiles) {
                await deleteFile(DRIVE, file.id, file.name);
            }
        } else if (effectiveReplaceMode === REPLACE_MODES.UPDATE_IN_PLACE) {
            // Update the first file in place and return
            if (existingFiles.length > 1) {
                console.log(`Warning: Multiple files with name '${fileName}' found. Updating the first one.`);
            }
            const updatedFile = await updateFile(existingFiles[0].id, fileName, filePath, shareWith, description);

            // Set outputs
            actions.setOutput('file_id', updatedFile.id);
            actions.setOutput('file_name', updatedFile.name);
            if (updatedFile.webViewLink) {
                actions.setOutput('web_view_link', updatedFile.webViewLink);
            }

            return updatedFile;
        }
        // For ADD_NEW mode, we just proceed with creating a new file
    }

    // Create a new file
    console.log(`Uploading ${fileName} ...`);
    const fileMetadata = {
        name: fileName,
        parents: [uploadFolderId],
    };

    actions.debug(`Creating ${fileMetadata.name} in ${fileMetadata.parents[0]}`);

    const params = getUploadParams(fileMetadata, filePath, convertFiles, description);

    const createFileOperation = async () => {
        return DRIVE.files.create(params);
    };

    const result = await withRetry(createFileOperation, `Upload file ${fileName}`);
    console.log(`File '${fileName}' uploaded successfully. ID: ${result.data.id}`);

    if (result.data.webViewLink) {
        console.log(`View file: ${result.data.webViewLink}`);
    }

    // Set outputs
    actions.setOutput('file_id', result.data.id);
    actions.setOutput('file_name', result.data.name);
    if (result.data.webViewLink) {
        actions.setOutput('web_view_links', result.data.webViewLink);
    }

    // Handle auto-sharing
    if (shareWith) {
        await grantPermissions(DRIVE, result.data.id, shareWith, sendNotification);
    }

    return result.data;
}

/**
/**
 * Apply retention policy to keep only the most recent files with the same name
 *
 * @param {object} drive - Google Drive API instance
 * @param {string} folderId - ID of the folder to clean
 * @param {string} fileName - Name of the file to check retention for
 * @param {number} maxCount - Maximum number of files to keep (0 to disable)
 * @returns {Promise<void>}
 */
async function applyRetentionPolicy(drive, folderId, fileName, maxCount) {
    if (maxCount <= 0) {
        return;
    }

    console.log(`Applying retention policy for '${fileName}': ensuring max ${maxCount} versions...`);

    const listFilesOperation = async () => {
        return drive.files.list({
            q: `'${folderId}' in parents and name = '${fileName}' and trashed=false`, // Scope to specific file name
            orderBy: 'createdTime desc',
            fields: 'files(id, name, createdTime)',
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
            pageSize: 100 // Should be enough for versions
        });
    };

    const { data: { files } } = await withRetry(listFilesOperation, `List versions of ${fileName} in ${folderId}`);

    if (files.length > maxCount) {
        const filesToDelete = files.slice(maxCount);
        console.log(`Found ${files.length} versions of '${fileName}'. `
            + `Deleting ${filesToDelete.length} old versions...`);

        for (const file of filesToDelete) {
            try {
                await deleteFile(drive, file.id, file.name);
            } catch (error) {
                console.error(`Failed to delete old version ${file.name} (${file.id}): ${error.message}`);
                // Continue deleting others even if one fails
            }
        }
    } else {
        console.log(`Found ${files.length} versions of '${fileName}'. No deletion needed.`);
    }
}

async function main() {
    try {
        // Get configuration input
        const credentials = actions.getInput('credentials', { required: true });
        const parentFolderId = getInputAndDebug('parent_folder_id', { required: true });
        const target = getInputAndDebug('target', { required: true });
        const owner = getInputAndDebug('owner', { required: false });
        const childFolder = getInputAndDebug('child_folder', { required: false });
        const override = getBooleanInputAndDebug('override', { required: false });
        const filename = getInputAndDebug('name', { required: false });
        let replaceMode = getInputAndDebug('replace_mode', { required: false }) || REPLACE_MODES.ADD_NEW;
        const maxRetentionCount = parseInt(getInputAndDebug('max_retention_count', { required: false }) || '0', 10);
        const convertFiles = getBooleanInputAndDebug('convert_files', { required: false });
        const shareWith = getInputAndDebug('share_with', { required: false });
        const sendShareNotification = getBooleanInputAndDebug('send_share_notification', { required: false });
        const setMetadata = getBooleanInputAndDebug('set_metadata', { required: false });

        let description = '';
        if (setMetadata) {
            description = getMetadataDescription();
            console.log('Generated metadata description.');
        }

        // Validate inputs
        validateTarget(target);
        replaceMode = validateReplaceMode(replaceMode);

        // Authenticate with Google
        console.log('Authenticating with Google Drive API...');
        const credentialsJSON = parseCredentials(credentials);

        const scopes = [
            'https://www.googleapis.com/auth/drive',
            'https://www.googleapis.com/auth/drive.file',
        ];
        if (!credentialsJSON.client_email) {
            throw new Error('Credential parsing success but client_email is missing/empty');
        }
        if (!credentialsJSON.private_key) {
            throw new Error('Credential parsing success but private_key is missing/empty');
        }

        const privateKey = credentialsJSON.private_key.replace(/\\n/g, '\n');

        const auth = new google.auth.JWT({
            email: credentialsJSON.client_email,
            key: privateKey,
            scopes,
            subject: owner || undefined,
        });

        // Explicitly authorize to check for credential issues strictly
        await auth.authorize();

        // Set global `drive`
        DRIVE = google.drive({ version: 'v3', auth });

        // Test authentication
        try {
            await DRIVE.about.get({ fields: 'user' });
            console.log('Authentication successful.');
        } catch (error) {
            throw new Error(`Authentication failed: ${error.message}`);
        }

        console.log('Getting folder id...');
        const uploadFolderId = await getUploadFolderId(parentFolderId, childFolder);

        actions.debug(`uploadFolderId: ${uploadFolderId}`);

        let uploadCount = 0;
        let errorCount = 0;
        const uploadedFiles = [];

        if (target.includes('*')) {
            console.log(`Finding files matching pattern: ${target}`);
            const targets = new Glob(target, {});
            const matchedFiles = [];

            for await (const file of targets) {
                matchedFiles.push(file);
            }

            if (matchedFiles.length === 0) {
                throw new Error(`No files found matching pattern: ${target}`);
            }

            console.log(`Found ${matchedFiles.length} files to upload.`);

            for (const file of matchedFiles) {
                const fileName = path.basename(file);
                const filePath = path.resolve(file);

                if (!fs.lstatSync(filePath).isDirectory()) {
                    try {
                        const result = await uploadFile(
                            fileName,
                            filePath,
                            replaceMode,
                            override,
                            uploadFolderId,
                            convertFiles,
                            shareWith,
                            description,
                            sendShareNotification
                        );
                        uploadCount++;
                        uploadedFiles.push(result);

                        // Apply retention policy immediately for this file
                        if (maxRetentionCount > 0) {
                            await applyRetentionPolicy(DRIVE, uploadFolderId, fileName, maxRetentionCount);
                        }
                    } catch (error) {
                        console.error(`Error uploading ${fileName}: ${error.message}`);
                        actions.error(`Failed to upload ${fileName}: ${error.message}`);
                        errorCount++;
                    }
                } else {
                    console.log(`Skipping directory ${fileName}`);
                }
            }
        } else {
            const fileName = filename || path.basename(target);
            const filePath = path.resolve(target);

            if (fs.lstatSync(filePath).isDirectory()) {
                throw new Error(`Target is a directory: ${filePath}. Please specify a file or use a glob pattern.`);
            }

            const result = await uploadFile(
                fileName,
                filePath,
                replaceMode,
                override,
                uploadFolderId,
                convertFiles,
                shareWith,
                description,
                sendShareNotification
            );
            uploadCount++;
            uploadedFiles.push(result);

            // Apply retention policy immediately for this file
            if (maxRetentionCount > 0) {
                await applyRetentionPolicy(DRIVE, uploadFolderId, fileName, maxRetentionCount);
            }
        }

        console.log(`Upload summary: ${uploadCount} files uploaded successfully, ${errorCount} failures.`);

        if (errorCount > 0) {
            actions.setFailed(`${errorCount} file(s) failed to upload.`);
        } else {
            actions.setOutput('upload_count', uploadCount.toString());

            // Set outputs for multiple files
            if (uploadedFiles.length > 0) {
                const fileIds = uploadedFiles.map(file => file.id).join(',');
                const fileNames = uploadedFiles.map(file => file.name).join(',');
                const webViewLinks = uploadedFiles
                    .filter(file => file.webViewLink)
                    .map(file => file.webViewLink)
                    .join(',');

                actions.setOutput('file_ids', fileIds);
                actions.setOutput('file_names', fileNames);
                if (webViewLinks) {
                    actions.setOutput('web_view_links', webViewLinks);
                }
            }

            console.log('All uploads completed successfully.');
        }
    } catch (error) {
        actions.setFailed(`Action failed: ${error.message}`);
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    splitFolder,
    validateTarget,
    validateReplaceMode,
    getInputAndDebug,
    getBooleanInputAndDebug,
    getUploadFolderId,
    findExistingFiles,
    getUploadParams,
    applyRetentionPolicy,
    grantPermissions, // Export for testing
    parseCredentials,
    REPLACE_MODES // Exporting constants is often useful too
};
