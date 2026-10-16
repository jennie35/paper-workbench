# Project publishing workflow

The repository is `https://github.com/jennie35/paper-workbench.git`.

The owner requested that future changes made to this project be synchronized to
GitHub. After completing an authorized change, run checks appropriate to that
change, review the diff, commit the task's files, and push to the configured
upstream. Do not include unrelated local changes, private research data, `.env`
files, API keys, or credentials. If authentication, conflicts, or checks prevent
publishing, report that state accurately and preserve the local work.

Frontend pushes to `main` trigger the existing Pages workflow. Backend code is
stored on GitHub; it requires a separate running backend deployment. Do not
describe a successful Git push or Pages release as a running backend service.

This workflow applies when an agent works on this project. It does not install a
background file watcher or publish arbitrary edits made outside an active task.
