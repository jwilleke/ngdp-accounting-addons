---
title: CLAUDE.md
description: Guidance for Claude Code and other AI agents in this repo.
---

# CLAUDE.md

Guidance for Claude Code (and other AI agents) in this repo.

Read `AGENTS.md` and `private/project_log.md` before starting any work.
Session continuity lives in the `▶ Resume here` block at the top of `TODO.md`.
Priorities are GitHub issue labels; `TODO.md` is their generated mirror.

## What this is

ngdpbase add-ons for small-organization money tasks (dues, payments, donations, funds, events,
treasurer reports). See [README.md](README.md) and [docs/requirements.md](docs/requirements.md).

## Build / run

None yet: planning stage, no code.

## Architecture

<!-- Key files, directories, and data-flow summary. -->
<!-- What to read first when diving into the code. -->
<!-- Any generated files that must not be hand-edited. -->

## Conventions

<!-- Project-specific rules beyond what AGENTS.md covers. -->
<!-- Examples: naming patterns, preferred libraries, things to never do. -->

## Security / secrets

Never store card or bank account numbers; Stripe holds them. Stripe keys and donor/member data
must never be committed.
