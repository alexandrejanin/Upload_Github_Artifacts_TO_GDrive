const path = require('node:path');
const fs = require('node:fs');
const {
    splitFolder,
    validateTarget,
    validateReplaceMode,
    getUploadParams,
    applyRetentionPolicy,
    grantPermissions,
    parseCredentials,
    REPLACE_MODES
} = require('../src/index.js');

// Mock fs to simulate file sizes
jest.mock('node:fs', () => {
    const originalFs = jest.requireActual('node:fs');
    return {
        ...originalFs,
        statSync: jest.fn(),
        createReadStream: jest.fn().mockReturnValue('mock-stream'),
    };
});

// Mock @actions/core to avoid console spam and side effects
jest.mock('@actions/core', () => ({
    getInput: jest.fn(),
    getBooleanInput: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
    setFailed: jest.fn(),
    setOutput: jest.fn(),
}));

// Mock googleapis
jest.mock('googleapis', () => ({
    google: {
        auth: {
            JWT: jest.fn()
        },
        drive: jest.fn()
    }
}));

describe('Unit Tests', () => {
    describe('getUploadParams', () => {
        const mockFilePath = '/path/to/file';
        const mockMetadata = { name: 'test-file' };

        test('should use multipart for small files (< 5MB)', () => {
            // Mock file size to 1MB
            fs.statSync.mockReturnValue({ size: 1 * 1024 * 1024 });

            const params = getUploadParams(mockMetadata, mockFilePath);

            expect(params.uploadType).toBe('multipart');
            expect(fs.statSync).toHaveBeenCalledWith(mockFilePath);
        });

        test('should use resumable for large files (> 5MB)', () => {
            // Mock file size to 6MB
            fs.statSync.mockReturnValue({ size: 6 * 1024 * 1024 });

            const params = getUploadParams(mockMetadata, mockFilePath);

            expect(params.uploadType).toBe('resumable');
        });

        test('should use resumable for exact 5MB + 1 byte', () => {
            // Mock file size to 5MB + 1 byte
            fs.statSync.mockReturnValue({ size: (5 * 1024 * 1024) + 1 });

            const params = getUploadParams(mockMetadata, mockFilePath);

            expect(params.uploadType).toBe('resumable');
        });

        test('should use multipart for exact 5MB', () => {
            // Mock file size to 5MB
            fs.statSync.mockReturnValue({ size: 5 * 1024 * 1024 });

            const params = getUploadParams(mockMetadata, mockFilePath);

            expect(params.uploadType).toBe('multipart');
        });

        test('should set mimeType for convertible files when enabled', () => {
            const file = 'test.csv';
            fs.writeFileSync(file, 'content');
            try {
                const params = getUploadParams({ name: 'test.csv' }, file, true);
                expect(params.requestBody.mimeType).toBe('application/vnd.google-apps.spreadsheet');
            } finally {
                fs.unlinkSync(file);
            }
        });

        test('should not set mimeType when disabled', () => {
            const file = 'test.csv';
            fs.writeFileSync(file, 'content');
            try {
                const params = getUploadParams({ name: 'test.csv' }, file, false);
                expect(params.requestBody.mimeType).toBeUndefined();
            } finally {
                fs.unlinkSync(file);
            }
        });

        test('should ignore non-convertible files', () => {
            const file = 'test.jpg';
            fs.writeFileSync(file, 'content');
            try {
                const params = getUploadParams({ name: 'test.jpg' }, file, true);
                expect(params.requestBody.mimeType).toBeUndefined();
            } finally {
                fs.unlinkSync(file);
            }
        });
    });

    describe('splitFolder', () => {
        test('should split nested folder', () => {
            expect(splitFolder('a/b/c')).toEqual(['a', 'b/c']);
        });

        test('should handle single folder', () => {
            expect(splitFolder('folder')).toEqual(['folder', null]);
        });
    });

    describe('validateReplaceMode', () => {
        test('should accept valid modes', () => {
            expect(validateReplaceMode('add_new')).toBe('add_new');
            expect(validateReplaceMode('DELETE_FIRST')).toBe('delete_first');
        });

        test('should throw on invalid mode', () => {
            expect(() => validateReplaceMode('invalid_mode')).toThrow('Invalid replace_mode');
        });
    });

    describe('validateTarget', () => {
        test('should ignored glob pattern', () => {
            expect(() => validateTarget('*.zip')).not.toThrow();
        });

        test('should throw if file does not exist', () => {
            expect(() => validateTarget('nonexistent.file')).toThrow('Target file not found');
        });

        // We can create a temporary file to test success case
        test('should passed if file exists', () => {
            const tempFile = 'temp-test-file.txt';
            fs.writeFileSync(tempFile, 'content');
            try {
                expect(() => validateTarget(tempFile)).not.toThrow();
            } finally {
                fs.unlinkSync(tempFile);
            }
        });
    });

    describe('applyRetentionPolicy', () => {
        const mockFolderId = 'folder-123';
        const mockFileName = 'test-file.zip'; // New: file name for per-file retention
        const mockDrive = {
            files: {
                list: jest.fn(),
                delete: jest.fn()
            }
        };

        beforeEach(() => {
            jest.clearAllMocks();
        });

        test('should do nothing if maxCount is 0', async () => {
            await applyRetentionPolicy(mockDrive, mockFolderId, mockFileName, 0);
            expect(mockDrive.files.list).not.toHaveBeenCalled();
        });

        test('should do nothing if file count is <= maxCount', async () => {
            mockDrive.files.list.mockResolvedValue({
                data: { files: [{ id: '1' }, { id: '2' }] }
            });

            await applyRetentionPolicy(mockDrive, mockFolderId, mockFileName, 5);

            expect(mockDrive.files.list).toHaveBeenCalled();
            // Verify strict name filtering
            expect(mockDrive.files.list).toHaveBeenCalledWith(expect.objectContaining({
                q: expect.stringContaining(`name = '${mockFileName}'`)
            }));
            expect(mockDrive.files.delete).not.toHaveBeenCalled();
        });

        test('should delete excess files', async () => {
            // Return 3 files, keep 1. Should delete 2 (the oldest ones/last ones in sorted list)
            const files = [
                { id: 'new', name: 'new.zip' },
                { id: 'mid', name: 'mid.zip' },
                { id: 'old', name: 'old.zip' }
            ];

            mockDrive.files.list.mockResolvedValue({
                data: { files: files }
            });
            mockDrive.files.delete.mockResolvedValue({});

            await applyRetentionPolicy(mockDrive, mockFolderId, mockFileName, 1);

            expect(mockDrive.files.delete).toHaveBeenCalledTimes(2);
            expect(mockDrive.files.delete).toHaveBeenCalledWith({ fileId: 'mid', supportsAllDrives: true });
            expect(mockDrive.files.delete).toHaveBeenCalledWith({ fileId: 'old', supportsAllDrives: true });
        });
    });

    describe('grantPermissions', () => {
        const mockDrive = {
            permissions: {
                create: jest.fn()
            }
        };

        beforeEach(() => {
            jest.clearAllMocks();
        });

        test('should do nothing if email list is empty', async () => {
            await grantPermissions(mockDrive, 'file-123', '');
            expect(mockDrive.permissions.create).not.toHaveBeenCalled();
        });

        test('should grant permission to single email', async () => {
            await grantPermissions(mockDrive, 'file-123', 'test@example.com');
            expect(mockDrive.permissions.create).toHaveBeenCalledTimes(1);
            expect(mockDrive.permissions.create).toHaveBeenCalledWith(expect.objectContaining({
                fileId: 'file-123',
                requestBody: expect.objectContaining({
                    role: 'reader',
                    emailAddress: 'test@example.com'
                })
            }));
        });

        test('should grant permission to multiple emails', async () => {
            await grantPermissions(mockDrive, 'file-123', 'a@test.com, b@test.com');
            expect(mockDrive.permissions.create).toHaveBeenCalledTimes(2);
            expect(mockDrive.permissions.create).toHaveBeenCalledWith(expect.objectContaining({
                requestBody: expect.objectContaining({ emailAddress: 'a@test.com' })
            }));
            expect(mockDrive.permissions.create).toHaveBeenCalledWith(expect.objectContaining({
                requestBody: expect.objectContaining({ emailAddress: 'b@test.com' })
            }));
        });

        test('should handle trimmed emails', async () => {
            await grantPermissions(mockDrive, 'file-123', ' a@test.com , b@test.com ');
            expect(mockDrive.permissions.create).toHaveBeenCalledWith(expect.objectContaining({
                requestBody: expect.objectContaining({ emailAddress: 'a@test.com' })
            }));
        });
    });

    describe('parseCredentials', () => {
        const validCreds = { client_email: 'foo', private_key: 'bar' };
        const jsonString = JSON.stringify(validCreds);
        const base64String = Buffer.from(jsonString).toString('base64');

        test('should parse plain JSON', () => {
            const result = parseCredentials(jsonString);
            expect(result).toEqual(validCreds);
        });

        test('should parse base64 encoded JSON', () => {
            const result = parseCredentials(base64String);
            expect(result).toEqual(validCreds);
        });

        test('should throw on invalid format', () => {
            expect(() => parseCredentials('invalid-junk')).toThrow('Invalid credentials format');
        });
    });
});
