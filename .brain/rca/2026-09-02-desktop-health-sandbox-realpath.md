---
version: "0.1.2"
created_at: "2026-09-02T16:28:00+07:00,RWANG,d534d3f4299227162093c7dc02341da08144a98d"
last_update: "2026-09-04T06:02:32+07:00,RWANG"
status: "stable"
superseded_by: null
attributes:
  domain: "verification"
  scope: "desktop-health"
  doc_type: "complexity-rule"
  artifact_type: "RCA"
  language: "th-TH"
---

# RCA — Desktop Runtime INVALID_HOME_ROOT in Managed Sandbox

## Symptom

คำสั่ง node tests/desktop-health.mjs และ node tests/sidecar-runtime.mjs ใน
managed filesystem sandbox รอ lifecycle record จน timeout หลัง server ส่ง
fatal code INVALID_HOME_ROOT

## Evidence

1. isolated diagnostic ด้วย fs.promises.realpath บน C:\Users\pc คืน
   EPERM: operation not permitted
2. Spotlight canonicalDirectory ต้อง realpath home directory และ fail closed
   ด้วย INVALID_HOME_ROOT เมื่อ canonical path หาไม่ได้
3. desktop health และ sidecar runtime tests ชุดเดิมผ่านเมื่อรันนอก managed
   filesystem sandbox
4. persona patch ไม่ได้แก้ spotlight.mjs, server startup หรือ runtime tests

## Root Cause

managed filesystem sandbox ปฏิเสธ async realpath ของ user home นอก
workspace ขณะที่ Spotlight startup ตั้งใจ canonicalize home root ก่อนรับ
search roots จึงเกิด environment-induced failure ไม่ใช่ product regression

## Why the Issue Escaped Detection

developer machine และ CI ปกติไม่ได้ใช้ filesystem restriction แบบเดียวกับ
managed sandbox และ test runner ไม่มี preflight ที่แยก EPERM จาก product error

## Proposed Prevention

- รัน desktop health gate ใน environment ที่อนุญาต canonical read ของ user home
- หากเจอ INVALID_HOME_ROOT ให้ยืนยันด้วย isolated realpath diagnostic ก่อนแก้ code
- ห้ามลดหรือ bypass Spotlight canonical home validation เพื่อให้ sandbox test ผ่าน
- บันทึกทั้ง sandbox failure และ unsandboxed pass ใน verification evidence

## VERSION DIFF

| From | To | Change |
|---|---|---|
| 0.1.0 stable | 0.1.1 stable | ขยาย evidence ให้ครอบคลุม sidecar runtime contract |
| 0.1.1 stable | 0.1.2 stable | เพิ่ม lifecycle metadata, version trace และ commit evidence โดยไม่เปลี่ยน root cause |
| Product 0.5.0 | Product 0.5.0 | Documentation-only correction; no product version bump |

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.0 | 2026-09-02 | stable | ยืนยัน managed sandbox realpath EPERM เป็นสาเหตุของ false regression | 3a6657c | RWANG |
| 0.1.1 | 2026-09-03 | stable | ขยาย evidence ให้ครอบคลุม sidecar runtime contract | 3a6657c | RWANG |
| 0.1.2 | 2026-09-04 | stable | เพิ่ม metadata, version diff และ historical commit trace | ba1200d | RWANG |
