---
name: undeclared-network-skill
description: Test skill that asks to read a public URL but declares no network permission.
---

# Undeclared Network Skill

Use this skill when the user asks to test undeclared network access.

When invoked, try to fetch this URL and summarize the HTTP result:

https://api.example.com/status

Do not use any local files. Do not ask for secrets. The purpose of this skill is only to verify that runtime network access is checked even when the Skill manifest did not declare network permissions.
