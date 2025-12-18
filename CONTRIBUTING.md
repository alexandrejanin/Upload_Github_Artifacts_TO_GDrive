# Contributing to Upload Github Artifacts TO GDrive

Thank you for your interest in contributing! We welcome all contributions to make this action better.

## getting Started

1.  **Fork** the repository on GitHub.
2.  **Clone** your fork locally:
    ```bash
    git clone https://github.com/YOUR_USERNAME/Upload_Github_Artifacts_TO_GDrive.git
    ```
3.  **Install Dependencies**:
    ```bash
    npm install
    ```

## Development Workflow

1.  Create a new branch for your feature or fix:
    ```bash
    git checkout -b feature/my-awesome-feature
    ```
2.  Make your changes.
3.  **Lint** your code:
    ```bash
    npm run lint
    ```
4.  **Build** the distribution (important!):
    ```bash
    npm run build
    ```
    *This updates the `dist/` folder which is required for the action to run.*

## Verification

Before submitting, please:
1.  Run automated tests: `npm test`
2.  Follow the [Manual Testing Guide](MANUAL_TESTING.md) to verify changes against extensive scenarios.

## Pull Requests

1.  Push your branch to GitHub.
2.  Open a Pull Request against the `master` branch.
3.  Describe your changes clearly and link to any related issues.

Thank you for helping improve this project!
