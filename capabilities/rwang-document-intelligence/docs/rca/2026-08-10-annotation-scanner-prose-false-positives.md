---
title: "RCA: annotation scanner captures explanatory prose"
date: "2026-08-10"
status: "resolved"
scope: "scripts/scan-annotations.ps1"
---

# RCA: annotation scanner captures explanatory prose

## Symptom

The scanner reports annotation counts from its own help/comments, including
words following `@tested` and IDs shown only as prose examples.

## Evidence

The old regular expression searched any text containing an annotation token and
accepted arbitrary trailing words. Its report listed `annotations` and `FR-001`
from explanatory text rather than source annotations.

## Root cause

The grammar had no comment-position anchor and no field-specific value syntax.
It matched documentation prose as if it were a source annotation.

## Why it escaped detection

The smoke check counted matches but had no negative fixture containing
annotation-like prose.

## Prevention

Anchor recognition to supported comment prefixes, constrain requirement/spec IDs
and test references, and run positive plus prose-negative fixtures.
