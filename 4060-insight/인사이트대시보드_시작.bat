@echo off
chcp 65001 > nul
echo.
echo  4060 인사이트 대시보드 시작 중...
echo  종료하려면 이 창을 닫으세요.
echo.
node "%~dp0server.js"
pause
