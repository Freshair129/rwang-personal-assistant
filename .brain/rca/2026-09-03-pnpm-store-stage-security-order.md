---
version: "0.2.0b"
doc_version: "0.2.0"
doc_status: "approved"
created_at: "2026-09-03T00:52:00+07:00,RWANG,d534d3f4299227162093c7dc02341da08144a98d"
last_update: "2026-09-04T05:34:37+07:00,RWANG"
status: "beta"
superseded_by: null
attributes:
  domain: "release-security"
  scope: "desktop-staging-ci-release"
  doc_type: "complexity-rule"
  artifact_type: "RCA"
  language: "th-TH"
  change_risk: "MEDIUM"
---

# RCA — pnpm Store Breaks the Post-stage Security Gate

## Symptom

หลังรัน pnpm desktop:stage แล้ว pnpm test:security ล้มที่
Document Intelligence scan ด้วย UNSAFE_REPOSITORY_PATH แม้ security suite
ชุดเดียวกันจะผ่านก่อน staging

หลัง push แล้ว fresh GitHub Actions runner ยังล้มใน `pnpm desktop:stage` ด้วย
`Get-FileHash is not recognized` ทำให้ security, Rust และ Tauri build gates
หลังจากนั้นไม่ได้รัน

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
6. GitHub job `100395379042` รัน acquisition script โดยตรงใน PowerShell 7 และ
   ผ่าน แต่ `pnpm desktop:stage` เปิด nested `powershell.exe -NoProfile` แล้ว
   ล้มระหว่างสร้าง runtime manifest เพราะ resolve `Get-FileHash` ไม่ได้
7. การ import `Microsoft.PowerShell.Utility` ใน stage script ไม่ได้ป้องกัน
   command-resolution failure ที่พบจริงบน hosted runner

## Root Cause

staging command ไม่ได้ pin pnpm global-virtual-store behavior และคัดลอก
pnpm install metadata เข้า artifact หลัง materialize dependency tree เมื่อ
temporary workspace ถูกลบ project junction ใน shared store จึง dangling และ
ชนกับ fail-closed repository traversal ใน security gate ที่รันหลัง staging

CI failure มี root cause แยกที่การคำนวณ digest พึ่ง PowerShell cmdlet discovery
ภายใน shell chain ต่างชนิด (`pwsh -> pnpm -> powershell.exe`) แทนที่จะใช้
cryptography primitive ที่ script ควบคุมเอง จึงให้ผลต่างจาก acquisition step
ที่รันโดยตรงใน `pwsh`

## Why the Issue Escaped Detection

- security suite ถูกตรวจครั้งแรกก่อน staging
- CI ปิด global virtual store โดยปริยาย แต่ local pnpm 11 เปิด จึงเกิด
  environment-dependent ordering bug
- desktop package tests ตรวจ reparse point ใน staged runtime แต่ยังไม่ตรวจ
  build-machine path ใน pnpm metadata หรือ post-stage security ordering
- local validation ไม่ได้จำลอง shell chain ของ hosted runner และ static test
  กลับยืนยันว่ามี `Get-FileHash` แทนที่จะป้องกัน dependency ดังกล่าว

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
6. แทน `Get-FileHash` ใน acquisition/staging ด้วย .NET SHA-256 helper ที่เปิด
   stream และ dispose hash/stream ใน `finally`
7. ให้ CI เรียก acquisition และ stage scripts โดยตรงใน explicit `pwsh` steps
   ไม่เปิด nested Windows PowerShell ผ่าน package wrapper
8. บังคับ release job พบ `RWANG_*_x64-setup.exe` เพียงไฟล์เดียว ตรวจ digest
   ก่อน/หลัง copy และตรวจข้อความใน `SHA256SUMS.txt` แบบ exact equality
9. นำ synthetic supply-chain document ออกจาก artifact จนกว่าจะมี generator
   ที่อนุมัติ และเพิ่ม contract ป้องกัน `.env` / `.env.*` ใน staged tree/manifest

## Verification Evidence

Historical evidence recorded for baseline commit
`3a6657caf0519f54b8bee05658f3047856e64b65` before the alignment patch:

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

Current alignment-patch evidence (artifact hashes above are historical and do
not identify binaries rebuilt from the current source):

- 2026-09-04: direct `pwsh` staging ผ่านด้วย pinned Node/archive hashes และ
  local virtual store; `pnpm test:desktop-package` ผ่านหลังสร้าง staged tree
- 2026-09-04: `pnpm test:security` ผ่านทันทีหลัง stage รวม Document
  Intelligence, Spotlight, remote/backend hardening และ persona catalog 45 cases
- focused package contract ยืนยัน .NET hashing, explicit `pwsh`, stage-before-
  security ordering, exact installer/checksum contract และไม่มี environment
  secret file ใน staged source หรือ manifest
- current local source ผ่าน `tauri build --no-bundle` และสร้าง
  `RWANG_0.5.0_x64-setup.exe`; raw SHA-256 คือ
  `0d2ef2529b353bfe7fc62fb86fbc7e764124e6d2fb897cb998d21bb064a48187`
  และ installer SHA-256 คือ
  `be46bf3ae0433128ef92f75746e666c6c59b3298136a40a2de4564041392dc74`;
  ทั้งคู่ `NotSigned` และยังไม่ถูกนับเป็น clean-machine smoke evidence
- fresh GitHub Actions rerun ยังเป็น exit criterion; local pass ไม่ถูกนับเป็น
  clean-machine Windows 10/11 installer evidence

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
- fresh PR workflow ผ่านทุก downstream gate หลัง staging
- release artifact มี installer หนึ่งไฟล์และ checksum ที่ตรงกันแบบ exact match
- manual Windows 11 และ Windows 10 VM evidence ถูกบันทึกก่อน production release

## Version Diff

| From | To | Change |
|---|---|---|
| RCA none | 0.1.0b candidate | บันทึก post-stage security ordering root cause และ patch contract |
| RCA 0.1.0b | 0.2.0b beta | เพิ่ม nested-shell CI root cause, checksum และ release evidence contract |
| Product 0.5.0 | Product 0.5.0 | hotfix ภายใน release pipeline; ไม่ bump public product version |

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.0b | 2026-09-03 | candidate | เสนอปิด dangling pnpm project link และ build-path metadata leak | 3a6657c | RWANG |
| 0.1.0b | 2026-09-03 | beta | ใช้ hotfix และผ่าน post-stage security, package, Rust, build และ artifact smoke gates | 3a6657c | RWANG |
| 0.2.0b | 2026-09-04 | beta | ใช้ shell-independent hashing และทำ CI/checksum/secret/VM contracts ให้ตรงหลักฐาน | uncommitted | RWANG |
