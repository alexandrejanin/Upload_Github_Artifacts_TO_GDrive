const path = require('node:path');
const fs = require('node:fs');
const {
    splitFolder,
    validateTarget,
    validateReplaceMode,
    getUploadParams,
    applyRetentionPolicy,
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
            await applyRetentionPolicy(mockDrive, mockFolderId, 0);
            expect(mockDrive.files.list).not.toHaveBeenCalled();
        });

        test('should do nothing if file count is <= maxCount', async () => {
            mockDrive.files.list.mockResolvedValue({
                data: { files: [{ id: '1' }, { id: '2' }] }
            });

            await applyRetentionPolicy(mockDrive, mockFolderId, 5);

            expect(mockDrive.files.list).toHaveBeenCalled();
            expect(mockDrive.files.delete).not.toHaveBeenCalled();
        });

        test('should delete excess files', async () => {
            // Return 3 files, keep 1. Should delete 2 (the oldest ones/last ones in sorted list)
            // Note: The code sorts by createdTime desc (newest first).
            // So if we have [newest, middle, oldest], and max=1, we keep newest.
            // We delete middle and oldest.

            const files = [
                { id: 'new', name: 'new.zip' },
                { id: 'mid', name: 'mid.zip' },
                { id: 'old', name: 'old.zip' }
            ];

            mockDrive.files.list.mockResolvedValue({
                data: { files: files }
            });
            mockDrive.files.delete.mockResolvedValue({});

            await applyRetentionPolicy(mockDrive, mockFolderId, 1);

            expect(mockDrive.files.delete).toHaveBeenCalledTimes(2);
            expect(mockDrive.files.delete).toHaveBeenCalledWith({ fileId: 'mid', supportsAllDrives: true });
            expect(mockDrive.files.delete).toHaveBeenCalledWith({ fileId: 'old', supportsAllDrives: true });
        });
    });
});
