@echo off
rem Consola de demostracion del TP. Necesita el stack levantado (docker compose up -d)
rem y las dependencias de gamingApp instaladas (pnpm install dentro de gamingApp).
chcp 65001 >nul
node "%~dp0scripts\consola.mjs" %*
