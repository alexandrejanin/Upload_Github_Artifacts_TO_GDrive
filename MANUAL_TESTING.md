# Manual Testing Guide

Since this Action interacts with the real Google Drive API, automated tests can only cover so much (mocking). Developers should perform these manual tests using `manual-release.yml` or a dedicated test workflow before major releases.

## Prerequisites
- A Google Service Account JSON key.
- A dedicated "Test Folder" in Google Drive.
- A "Shared Drive" (optional, for quota testing).

## Test Scenarios

### 1. Basic Upload
- **Goal**: Verify simple file upload works.
- **Input**: Single file (`target: test.txt`).
- **Check**: File appears in Drive folder.

### 2. Multi-File Glob Upload
- **Goal**: Verify globbing works.
- **Input**: Pattern (`target: dist/*.js`).
- **Check**: All matching files appear in Drive.

### 3. Nested Folders
- **Goal**: Verify child folder creation.
- **Input**: `child_folder: 'builds/v1'`.
- **Check**: File is inside `Root > builds > v1`.

### 4. Overwrite / Replace Modes
- **Goal**: Verify `replace_mode` options.
- **Test A (add_new)**: Upload same file twice. -> Result: duplicate files (different IDs).
- **Test B (delete_first)**: Upload file. Upload again with `replace_mode: delete_first`. -> Result: Old file gone, new file present (new ID).
- **Test C (update_in_place)**: Upload file. Upload changed content with `replace_mode: update_in_place`. -> Result: Same ID, content updated, version history +1.

### 5. Retention Policy (Version History)
- **Goal**: Verify per-file retention.
- **Setup**: `max_retention_count: 2`.
- **Action**: Upload `app.zip` 4 times (`replace_mode: add_new` or `add_new` default).
- **Check**: Only the 2 most recent `app.zip` files remain. Unrelated files (`notes.txt`) are untouched.

### 6. Auto-Conversion
- **Goal**: Verify Google Docs conversion.
- **Input**: `convert_files: true`, `target: readme.md`.
- **Check**: File appears as a Google Doc (not a markdown file).

### 7. Share Notifications
- **Goal**: Verify email alerts.
- **Input**: `share_with: your@email.com`, `send_share_notification: true`.
- **Check**: Receive an email from Google: "Service Account shared a file with you".

### 8. Authentication (JSON & Base64)
- **Goal**: Verify both credential formats work.
- **Test A**: Paste raw JSON into secret.
- **Test B**: Paste Base64 encoded JSON into secret.

### 9. Large File Upload (Resumable)
- **Goal**: Verify logic switch for >5MB files.
- **Action**: Upload a >6MB file.
- **Check**: Logs show "Starting Resumable Upload...". File integrity is good.
