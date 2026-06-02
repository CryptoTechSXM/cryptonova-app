@echo off
echo Clearing stale git lock files...
if exist ".git\index.lock" (
    del /f ".git\index.lock"
    echo index.lock removed.
)
if exist ".git\refs\remotes\origin\main.lock" (
    del /f ".git\refs\remotes\origin\main.lock"
    echo main.lock removed.
)
echo.
echo Running git sync...
python git_sync.py
echo.
pause
