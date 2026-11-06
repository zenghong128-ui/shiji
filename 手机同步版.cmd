@echo off
cd /d "%~dp0"
python stop.py
start "" pythonw "%~dp0app.py" --lan
