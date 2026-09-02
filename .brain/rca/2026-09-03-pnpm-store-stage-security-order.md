---
version: "0.1.0b"
doc_version: "0.1.0"
doc_status: "approved"
created_at: "2026-09-03T00:52:00+07:00,RWANG,d534d3f4299227162093c7dc02341da08144a98d"
last_update: "2026-09-03T01:10:25+07:00,RWANG"
status: "beta"
superseded_by: null
attributes:
  domain: "release-security"
  scope: "desktop-staging-document-intelligence"
  artifact_type: "RCA"
  language: "th-TH"
  change_risk: "MEDIUM"
---

# RCA — pnpm Store Breaks the Post-stage Security Gate

## Symptom

หลังรัน pnpm desktop:stage แล้ว pnpm test:security ล้มที่
Document Intelligence scan ด้วย UNSAFE_REPOSITORY_PATH แม้ security suite
ชุดเดียวกันจะผ่านก่อน staging

## Evidence

1. stage script ติดตั้ง production dependencies ใน temporary path
   desktop/stage/.rwang-build-*/.dependency-install แล้วลบ path นั้น
2. pnpm 11 เปิด global virtual store เป็นค่าเริ่มต้นนอก CI และสร้าง junction
   ใต้ .pnpm-store/v11/projects กลับไปยัง temporary dependency workspace
3. พบ junction ที่ target ไม่มีอยู่จริงสองรายการหลัง build สองรอบ
4. Document Intelligence ตั้งใจ fail closed เมื่อ lstat/realpath ของ repository
   entry ไม่เสถียร จึงส่ง UNSAFE_REPOSITORY_PATH
5. staged node_modules/.modules.yaml ยังมี absolute storeDir และ
   virtualStoreDir ของ build machine ซึ่งไม่จำเป็นต่อ Node runtime

## Root Cause

staging command ไม่ได้ pin pnpm global-virtual-store behavior และคัดลอก
pnpm install metadata เข้า artifact หลัง materialize dependency tree เมื่อ
temporary workspace ถูกลบ project junction ใน shared store จึง dangling และ
ชนกับ fail-closed repository traversal ใน security gate ที่รันหลัง staging

## Why the Issue Escaped Detection

- security suite ถูกตรวจครั้งแรกก่อน staging
- CI ปิด global virtual store โดยปริยาย แต่ local pnpm 11 เปิด จึงเกิด
  environment-dependent ordering bug
- desktop package tests ตรวจ reparse point ใน staged runtime แต่ยังไม่ตรวจ
  build-machine path ใน pnpm metadata หรือ post-stage security ordering

## Implemented Solution

1. เพิ่ม --config.enable-global-virtual-store=false ให้ production install ใน
   stage script เพื่อไม่สร้าง project junction กลับไปยัง temporary workspace
2. ลบเฉพาะ pnpm install metadata ที่ runtime ไม่ใช้ก่อน materialize artifact:
   .modules.yaml, .package-map.json, .pnpm-workspace-state-v1.json และ
   .pnpm/lock.yaml; ลบ .pnpm เฉพาะเมื่อว่าง
3. เพิ่ม .pnpm-store ใน Document Intelligence skipped dependency/cache roots
   เช่นเดียวกับ node_modules โดยยัง lstat root entry ก่อน skip และยัง fail closed
   สำหรับ source paths อื่น
4. เพิ่ม contract assertions สำหรับ pinned pnpm flag, metadata exclusion และ
   บังคับ release job รัน security/desktop contracts หลัง stage บน runner เดียวกับ
   artifact ก่อน build NSIS
5. ลบแบบ one-time เฉพาะ dangling junction ที่ตรวจแล้วว่า target อยู่ใต้
   desktop/stage/.rwang-build-*/.dependency-install และ target ไม่มีอยู่จริง

## Verification Evidence

- `pnpm desktop:stage` ผ่านโดย pin local virtual store; staged manifest มี
  2,419 files และไม่พบ metadata ต้องห้าม, build-path marker หรือ project
  junction
- ลบ dangling junction ที่ตรวจ target แล้วสองรายการ
  `9da6677d5fd8f83ef4242f4a3bca91c1` และ
  `a3780300f07a05022f9badf6d09ec1ff`; เป็น cache metadata ที่ pnpm สร้างใหม่ได้
- `pnpm test:security` ผ่านทันทีหลัง stage และหลัง final build; persona scenario
  coverage ผ่าน 33 scenarios
- `pnpm test:desktop-package` และ `pnpm test:desktop-contract` ผ่าน รวม contract
  ที่ค้นหา `.rwang-build-`, `.dependency-install`, `cmd-shim-target=`,
  `virtualStoreDir` และ `storeDir` ใน staged text files
- Windows release workflow รัน `stage -> security -> desktop contract -> NSIS`
  ใน job เดียวกัน และมี static ordering contract ป้องกันการถอยกลับ
- scanner fixture ยืนยันว่า dangling link ใต้ regular `.pnpm-store` ถูกตัดออกจาก
  traversal boundary แต่ link ที่ชี้ออกนอก application root ยังถูกปฏิเสธด้วย
  `UNSAFE_REPOSITORY_PATH`
- `pnpm check`, `cargo fmt --check`, `cargo check --locked` และ
  `cargo test --locked` ผ่าน; Rust ผ่าน 8 unit tests และ 7 integration tests
- `tauri build --no-bundle` และ NSIS build ผ่าน; artifact smoke ยืนยัน desktop
  host, bundled Node child และ loopback listener ทำงาน แล้วหยุด process ที่ใช้ทดสอบ
- raw binary SHA-256:
  `2ddf5b459b7ec569a2b19c19604a59025d29af0d88361fe8b2a1a13899bf12e9`
- NSIS installer SHA-256:
  `64bba9b3167d6976ec2586d2257113926957d7479197bd685d57cceae94745ee`
- ทั้งสอง artifact ยัง `NotSigned`; ต้องผ่าน code-signing process ก่อนเผยแพร่ภายนอก

## Risk Assessment

MEDIUM: แก้ทั้ง release staging และ repository traversal policy แต่ไม่เปลี่ยน
runtime permission, approval gate, external action หรือ application data

## Success Criteria

- pnpm desktop:stage ผ่านและไม่สร้าง junction ใหม่ไปยัง .rwang-build path
- staged runtime ไม่มี pnpm metadata หรือ absolute build-machine path
- pnpm test:security ผ่านเมื่อรันทันทีหลัง staging
- pnpm test:desktop-package และ pnpm test:desktop-contract ผ่าน
- scanner ยังปฏิเสธ unsafe links นอก dependency/cache roots
- raw binary, NSIS installer และ artifact smoke test ผ่านหลัง rebuild

## Version Diff

| From | To | Change |
|---|---|---|
| RCA none | 0.1.0b candidate | บันทึก post-stage security ordering root cause และ patch contract |
| Product 0.5.0 | Product 0.5.0 | hotfix ภายใน release pipeline; ไม่ bump public product version |

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.0b | 2026-09-03 | candidate | เสนอปิด dangling pnpm project link และ build-path metadata leak | uncommitted | RWANG |
| 0.1.0b | 2026-09-03 | beta | ใช้ hotfix และผ่าน post-stage security, package, Rust, build และ artifact smoke gates | uncommitted | RWANG |
