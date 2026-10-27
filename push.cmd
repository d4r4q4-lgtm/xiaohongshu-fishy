@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ========================================
echo   推送到 GitHub: d4r4q4-lgtm/xiaohongshu-fishy
echo ========================================
echo.
echo 正在推送，如果弹出登录窗口，请点 Authorize 授权...
echo.
git push -u origin main
if %errorlevel%==0 (
  echo.
  echo [成功] 仓库地址: https://github.com/d4r4q4-lgtm/xiaohongshu-fishy
) else (
  echo.
  echo [失败] 常见原因：
  echo   1. 远程仓库还没创建
  echo      去 https://github.com/new 建一个名字叫 xiaohongshu-fishy 的空仓库
  echo      注意：不要勾选 README / .gitignore / License
  echo   2. 没有登录 GitHub ^(弹窗里没点授权^)
  echo   3. 网络问题，多重试几次或开代理
)
echo.
pause
