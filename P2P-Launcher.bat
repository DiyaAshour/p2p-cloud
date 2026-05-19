@echo off
title P2P Storage Browser
SET NODE_OPTIONS=--max-old-space-size=2048
pnpm electron:dev
