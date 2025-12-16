const path = require('node:path');
const fs = require('node:fs');
const {
    splitFolder,
    validateTarget,
    validateReplaceMode,
    REPLACE_MODES
} = require('../src/index.js');

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
});
