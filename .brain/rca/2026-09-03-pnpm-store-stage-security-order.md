---
version: "0.2.5b"
doc_version: "0.2.5"
doc_status: "approved"
created_at: "2026-09-03T00:52:00+07:00,RWANG,d534d3f4299227162093c7dc02341da08144a98d"
last_update: "2026-09-04T06:38:00+07:00,RWANG"
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

หลังแก้ shell/hash contract แล้ว fresh run `33815919894` ผ่าน staging แต่ล้ม
ที่ Document Intelligence link-policy fixture: scan ของ root ที่มี dangling
junction อยู่ใต้ `.pnpm-store` ใช้เวลาครบ 30 วินาทีและจบเป็น `timed-out`
แทน `passed`

หลัง bounded-scanner patch แล้ว fresh run `33816585953` ไม่ timeout แต่ล้มทันที
ด้วย `DOCUMENT_INTELLIGENCE_INTEGRITY`: digest ของ `scan-annotations.ps1`
ไม่ตรงกับค่า pin

หลัง canonical-EOL patch แล้ว fresh run `33817028416` ผ่าน integrity check แต่
link-policy fixture ยัง timeout แสดงว่าเอา `-Recurse` ออกอย่างเดียวยังไม่ตัด
PowerShell provider ออกจาก junction path

หลัง name-first .NET enumeration แล้ว fresh run `33817561483` ยัง timeout ที่
fixture เดิม จึงหักล้างสมมติฐานว่า provider materialization เป็น root cause
สุดท้าย; ต้องแยก process launch กับ script phases ก่อนเปลี่ยน behavior เพิ่ม

bounded trace ใน fresh run `33817809048` บันทึก `script-start` แต่ไม่มี
`path-resolved` ก่อน timeout 30,024 ms จึงระบุจุดค้างได้ว่าเป็น
`Resolve-Path $Path` ก่อน scanner enumeration เริ่ม

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
8. job `100847928317` ของ run `33815919894` ผ่าน dependency install,
   JavaScript check, Node acquisition และ staging แล้วล้มเฉพาะ
   `Run post-stage security checks`; assertion ระบุ actual `timed-out`
9. adapter preflight มี `.pnpm-store` ใน `SCAN_SKIPPED_DIRECTORIES` แต่ pinned
   `scan-annotations.ps1` ใช้ `Get-ChildItem -Recurse` และไม่มี `.pnpm-store`
   ใน `$SkipDirs`; file-level `Where-Object` ทำงานหลัง recursion เริ่มแล้ว จึง
   ไม่สามารถตัด junction ก่อน traversal ได้
10. `.gitattributes` กำหนด `*.ps1 text eol=crlf`; digest ใน commit `fe93e5f`
    ถูกคำนวณจาก working file หลัง patch ซึ่งมี line endings แบบ mixed ขณะที่
    fresh checkout materialize เป็น CRLF ทั้งไฟล์ จึงได้ byte digest คนละค่า
11. run `33817028416` ใช้ canonical digest แล้วเริ่ม scan ได้ แต่ใช้เวลาครบ
    30 วินาทีที่ fixture เดิม; bounded implementation ยังเรียก
    `Get-ChildItem` เพื่อ materialize entries ก่อน `$SkipDirs` ตรวจชื่อ child
12. run `33817809048` ส่ง sanitized diagnostics เพียง
    `rwang-scan-phase:script-start`; marker ถัดไปอยู่หลัง `Resolve-Path` จึงเป็น
    หลักฐานตรงว่าการค้างเกิดใน provider-based root resolution

## Root Cause

staging command ไม่ได้ pin pnpm global-virtual-store behavior และคัดลอก
pnpm install metadata เข้า artifact หลัง materialize dependency tree เมื่อ
temporary workspace ถูกลบ project junction ใน shared store จึง dangling และ
ชนกับ fail-closed repository traversal ใน security gate ที่รันหลัง staging

CI failure มี root cause แยกที่การคำนวณ digest พึ่ง PowerShell cmdlet discovery
ภายใน shell chain ต่างชนิด (`pwsh -> pnpm -> powershell.exe`) แทนที่จะใช้
cryptography primitive ที่ script ควบคุมเอง จึงให้ผลต่างจาก acquisition step
ที่รันโดยตรงใน `pwsh`

fresh link-policy failure มี root cause ที่ traversal contract มีสองชั้นแต่
บังคับใช้ไม่เท่ากัน: JS preflight ตัด `.pnpm-store` ก่อนเดิน tree ขณะที่ pinned
PowerShell scanner ใช้ recursive provider traversal ซึ่งเข้า dependency cache
และ junction ก่อน post-filter จะเห็น entry นั้น จึงวน/รอ dangling target จน
adapter timeout แม้ path ดังกล่าวควรอยู่นอก scan boundary

fresh integrity failure มี root cause ที่ runtime digest ผูกกับ physical newline
representation ของ checkout ทั้งที่ source-control contract อนุญาตให้ Git
materialize PowerShell text ต่างกันตาม declared EOL; การคำนวณค่าจาก transient
working tree จึงไม่ใช่ canonical source digest

สมมติฐาน provider enumeration ถูกหักล้างโดย run `33817561483`: scanner ไม่มี
`Get-ChildItem` แล้วแต่ยัง timeout ค่าเดิม หลักฐานปัจจุบันจำกัด remaining cause
ไว้ที่ process launch หรือ phase ภายใน fixed PowerShell action; ยังห้ามสรุปจุด
ใดจุดหนึ่งจนมี bounded phase trace

remaining root cause ที่ยืนยันแล้วคือ `Resolve-Path` ใช้ PowerShell provider
เพื่อ resolve scan root และไม่คืน control เมื่อ hosted-runner root มี ignored
directory ซึ่งบรรจุ dangling junction แม้ตัว scanner จะยังไม่ได้ enumerate
root; ดังนั้น skip policy ที่อยู่หลัง `Resolve-Path` ไม่มีโอกาสทำงาน

## Why the Issue Escaped Detection

- security suite ถูกตรวจครั้งแรกก่อน staging
- CI ปิด global virtual store โดยปริยาย แต่ local pnpm 11 เปิด จึงเกิด
  environment-dependent ordering bug
- desktop package tests ตรวจ reparse point ใน staged runtime แต่ยังไม่ตรวจ
  build-machine path ใน pnpm metadata หรือ post-stage security ordering
- local validation ไม่ได้จำลอง shell chain ของ hosted runner และ static test
  กลับยืนยันว่ามี `Get-FileHash` แทนที่จะป้องกัน dependency ดังกล่าว
- local Windows session สร้าง junction fixture ไม่ได้และข้าม test ด้วย
  `EPERM`; hosted runner สร้าง fixture ได้ จึงเป็น environment แรกที่ execute
  regression path จริง
- verification ก่อน commit ตรวจ hash และ test กับ transient working copy แต่ไม่
  materialize fresh checkout ตาม `.gitattributes`; CI จึงเป็นจุดแรกที่ตรวจ CRLF
  copy ทั้งไฟล์
- regression test พิสูจน์ policy ผ่าน local filesystem แต่ไม่มี contract ว่า
  skipped directory name ต้องถูกตัดก่อน provider object/attributes ถูกอ่าน

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
10. เปลี่ยน annotation scanner จาก provider-level `-Recurse` เป็น bounded
    directory enumeration ที่ตัด exact ignored-directory names และทุก reparse
    point ก่อน enqueue; บันทึก local security adaptation ใน source provenance
    และ pin digest ใหม่
11. canonicalize line endings ของ allowlisted PowerShell text เป็น LF เฉพาะตอน
    คำนวณ integrity SHA-256; เพิ่ม fixture ที่ rewrite scanner เป็น CRLF แล้วต้อง
    ผ่าน ขณะที่ content tamper เดิมยังต้อง fail closed
12. ใช้ `[System.IO.Directory]::EnumerateDirectories/EnumerateFiles` แทน
    PowerShell provider enumeration; ตรวจ exact skipped basename ก่อนเรียก
    `File.GetAttributes` และก่อน enqueue จากนั้นค่อยตัด reparse point
13. เพิ่ม test-only bounded phase trace โดยไม่ส่ง path/content และแนบ sanitized
    diagnostics เฉพาะ assertion failure เพื่อแยก launch/start/enumeration/report;
    trace นี้เป็น diagnostic step ไม่ใช่การอ้างว่า root cause ถูกแก้แล้ว
14. แทน `Resolve-Path` ด้วย `[System.IO.Path]::GetFullPath` และ
    `[System.IO.Directory]::Exists` ซึ่งไม่เข้า PowerShell provider; ถอด phase
    instrumentation หลังยืนยัน root cause โดยคง fixture เดิมเป็น regression gate

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
  `8beffed4b0f1c52d1825428583577358ac299c87cbcbde146f48637faf94b01b`
  และ installer SHA-256 คือ
  `bd07748615fa48b97f67dbaacc82fd8c28d344fb1af86c324c4f0a0de30e95a0`;
  ทั้งคู่ `NotSigned` และยังไม่ถูกนับเป็น clean-machine smoke evidence
- fresh GitHub Actions rerun ยังเป็น exit criterion; local pass ไม่ถูกนับเป็น
  clean-machine Windows 10/11 installer evidence
- fresh run `33815919894` ให้หลักฐาน regression เพิ่มเติม: staging ผ่าน แต่
  link-policy fixture timeout ตาม root cause ข้างต้น; run นี้ยังไม่ใช่ pass
- fresh run `33816585953` ยืนยันว่า bounded scanner ไม่ถึง timeout เดิม แต่เผย
  non-canonical EOL digest; run นี้ยังไม่ใช่ pass
- fresh run `33817028416` ผ่าน canonical digest แต่ timeout ที่ fixture เดิม
  ยืนยันว่า provider enumeration ยังอยู่ก่อน pruning; run นี้ยังไม่ใช่ pass
- fresh run `33817561483` ยัง timeout หลังตัด PowerShell provider ทั้งหมด จึง
  หักล้าง provider-root-cause hypothesis และบังคับให้เก็บ phase evidence
- fresh run `33817809048` ระบุ phase สุดท้ายเป็น `script-start` ก่อน
  `Resolve-Path`; เป็นหลักฐาน root cause สำหรับ provider-based root resolution

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
| RCA 0.2.0b | 0.2.1b beta | บันทึก hosted-runner traversal timeout และ bounded-scanner remediation |
| RCA 0.2.1b | 0.2.2b beta | บันทึก checkout EOL digest mismatch และ canonical hash contract |
| RCA 0.2.2b | 0.2.3b beta | ย้าย skipped-name pruning ให้อยู่ก่อน provider/attribute access |
| RCA 0.2.3b | 0.2.4b beta | บันทึก hypothesis ที่ถูกหักล้างและเพิ่ม bounded phase diagnosis |
| RCA 0.2.4b | 0.2.5b beta | ยืนยัน Resolve-Path root cause และเปลี่ยนเป็น .NET path resolution |
| Product 0.5.0 | Product 0.5.0 | hotfix ภายใน release pipeline; ไม่ bump public product version |

## CHANGELOG

| Version | Date | Status | Summary | Commit Hash | Agent |
|---|---|---|---|---|---|
| 0.1.0b | 2026-09-03 | candidate | เสนอปิด dangling pnpm project link และ build-path metadata leak | 3a6657c | RWANG |
| 0.1.0b | 2026-09-03 | beta | ใช้ hotfix และผ่าน post-stage security, package, Rust, build และ artifact smoke gates | 3a6657c | RWANG |
| 0.2.0b | 2026-09-04 | beta | ใช้ shell-independent hashing และทำ CI/checksum/secret/VM contracts ให้ตรงหลักฐาน | ba1200d | RWANG |
| 0.2.1b | 2026-09-04 | beta | ยืนยัน recursive scanner เดินเข้า ignored junction ก่อน post-filter และกำหนด bounded enumeration | a176e6f | RWANG |
| 0.2.2b | 2026-09-04 | beta | ยืนยัน transient-EOL digest drift และกำหนด LF-canonical PowerShell integrity hash | fe93e5f | RWANG |
| 0.2.3b | 2026-09-04 | beta | ยืนยัน provider enumeration ยังแตะ skipped junction และกำหนด name-first .NET traversal | fd0c971 | RWANG |
| 0.2.4b | 2026-09-04 | beta | หักล้าง provider hypothesis และกำหนด phase trace เพื่อยืนยัน remaining root cause | 062958d | RWANG |
| 0.2.5b | 2026-09-04 | beta | phase trace ยืนยัน Resolve-Path ค้างก่อน enumeration และกำหนด provider-free root resolution | 619132a | RWANG |
