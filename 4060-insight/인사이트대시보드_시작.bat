@echo off
chcp 65001 > nul
echo.
echo  트렌드 인사이트 대시보드 시작 중...
echo  종료하려면 이 창을 닫으세요.
echo.
rem 사내 SSL 검사 인증서 신뢰 (이 폴더 또는 상위 폴더의 corp-root-ca.pem 자동 탐지)
if exist "%~dp0corp-root-ca.pem" (
  set NODE_EXTRA_CA_CERTS=%~dp0corp-root-ca.pem
) else if exist "%~dp0..\corp-root-ca.pem" (
  set NODE_EXTRA_CA_CERTS=%~dp0..\corp-root-ca.pem
)
node "%~dp0server.js"
pause
