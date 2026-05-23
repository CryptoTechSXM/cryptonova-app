@echo off
:: CNMS MACD Adaptive — Daily Report Runner
:: Double-click this file to run the report manually,
:: or let Windows Task Scheduler run it automatically at 17:00.

cd /d "%~dp0"
echo Running MACD Adaptive daily report...
python macd_daily_report.py
echo.
echo Done. Check daily_reports folder for the markdown file.
pause
