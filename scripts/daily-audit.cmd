@echo off
rem Windows Task Scheduler wrapper (task: MPC-Escrow-DailyAudit, daily 09:00, runs at next boot if missed).
rem ASCII only: cmd.exe reads this file in the OEM code page, so no Korean here.
rem Output overwrites one log file in the vault folder; the Claude scheduled task only reads that log.
cd /d C:\Projects\mpc-escrow
echo [%date% %time%] daily-audit start > C:\ssabom\appdata\daily-audit-last.log
node scripts\daily-audit.js >> C:\ssabom\appdata\daily-audit-last.log 2>&1
echo [%date% %time%] exit code %errorlevel% >> C:\ssabom\appdata\daily-audit-last.log
