@echo off
start "" http://localhost:8000
start /min "" python -m http.server 8000