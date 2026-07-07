@echo off
chcp 65001 > nul
echo.
echo  네이버 최저가 검색기 시작 중...
echo  종료하려면 이 창을 닫으세요.
echo.
set NODE_EXTRA_CA_CERTS=%~dp0corp-root-ca.pem
node "%~dp0server.js"
pause
