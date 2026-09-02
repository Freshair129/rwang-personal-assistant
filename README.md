# RWANG (อาหวัง) · Local Personal Assistant

RWANG คือผู้ช่วยส่วนตัวแบบ local-first สไตล์ mission control ใช้ Ollama เป็นสมองหลัก คุยภาษาไทยด้วยข้อความหรือเสียง เชื่อม Home Assistant, IoT webhook และเครื่องมือจาก MCP ได้ พร้อมหน้าเว็บแบบ responsive/PWA สำหรับคอมพิวเตอร์และโทรศัพท์ในเครือข่ายเดียวกัน

โฟลเดอร์และชื่อ package ของโปรเจกต์คือ `C:\Users\pc\workspace\rwang-local-assistant`

## ความสามารถหลัก

- แชทกับโมเดล Ollama แบบ streaming พร้อมเลือก ดาวน์โหลด โหลด และ unload โมเดล
- กดไมค์เพื่อพูด ตั้งคำปลุกเริ่มต้นเป็น “อาหวัง” และอ่านคำตอบกลับด้วยเสียงของ browser
- อ่านสถานะและเตรียมคำสั่ง Home Assistant ผ่าน REST API ฝั่ง backend
- เชื่อม MCP ผ่าน Streamable HTTP, SSE หรือ local stdio พร้อมตรวจการเปลี่ยนแปลงของ tool definition
- เรียกอุปกรณ์ IoT อื่นผ่าน webhook แบบ `POST`, `PUT` หรือ `PATCH`
- แสดงบัตรอนุมัติก่อนส่งคำสั่งที่เปลี่ยนสถานะไปยัง Home Assistant, MCP หรือ IoT
- ใช้งานผ่านมือถือด้วยรหัสจับคู่ใช้ครั้งเดียวและ HttpOnly device credential แยกรายเครื่อง
- หน้า **Loadout** แบบ game inventory สำหรับเปิด/ปิด skills, connectors, perception และ schedules
- สั่งหน้า RWANG ด้วยท่ามือจาก MediaPipe, ตรวจ face presence/Face Profile และ Voice Profile แบบ device-local
- แชร์ tab/window/ทั้งหน้าจอไปมือถือผ่าน WebRTC โดย browser แสดงตัวเลือกและขออนุญาตทุกครั้ง
- Remote deck จากมือถือควบคุมเฉพาะหน้า RWANG (`navigate`, `scroll`, `spotlight`) ไม่มี OS mouse/keyboard/shell input
- Schedule เก็บ prompt ตามเวลาและให้ผู้ใช้กด RUN; external tool ทุกตัวยังคงผ่าน approval policy เดิม

## สิ่งที่ต้องมี

- Windows และ Node.js 22 ขึ้นไป
- Ollama ที่กำลังทำงานบน `http://127.0.0.1:11434`
- โมเดลที่รองรับ chat; ความสามารถเรียก tool อาจแตกต่างกันตามโมเดล
- Chrome หรือ Edge รุ่นปัจจุบันสำหรับ screen capture, WebRTC และ MediaPipe; กล้อง/ไมค์บนอุปกรณ์ LAN ต้องใช้ trusted HTTPS

ตรวจสอบและติดตั้ง dependency ครั้งแรก:

```powershell
cd C:\Users\pc\workspace\rwang-local-assistant
node --version
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

ถ้า Ollama ยังไม่ทำงาน ให้เปิดอีก terminal แล้วรัน `ollama serve` หรือเปิด Ollama Desktop จากนั้นดาวน์โหลดโมเดลจากหน้า Systems ของ RWANG หรือใช้ `ollama pull <MODEL>`

## เปิดใช้งาน

หลังติดตั้ง dependency แล้ว ดับเบิลคลิก `Start RWANG.cmd` ตัว launcher จะตรวจ server เดิม เปิด RWANG แบบเบื้องหลัง และเปิด <http://127.0.0.1:4173> ให้โดยอัตโนมัติ หากตั้ง native TLS แล้ว launcher จะเปิด `https://localhost:4173` แทน ตรวจปัญหาได้จาก `rwang.stdout.log` และ `rwang.stderr.log`

เปิดจาก terminal ได้เช่นกัน:

```powershell
cd C:\Users\pc\workspace\rwang-local-assistant
npm start
```

ค่าเริ่มต้นใหม่เป็น secure-by-default: HTTP bind เฉพาะ `127.0.0.1` และไม่เปิด LAN จนกว่าจะตั้ง trusted HTTPS หากกำหนด non-loopback host ผ่าน HTTP โดยไม่ตั้ง `RWANG_ALLOW_INSECURE_LAN=1` server จะปฏิเสธการเริ่มทำงานแทนการ downgrade แบบเงียบ

```powershell
$env:OLLAMA_CENTER_PORT = "4173"
npm start
```

## เปิด HTTPS สำหรับมือถือบน Windows

ปิด RWANG ที่กำลังทำงาน แล้วเปิด PowerShell ด้วยบัญชี Windows เดิมและรัน:

```powershell
cd C:\Users\pc\workspace\rwang-local-assistant
powershell -NoProfile -ExecutionPolicy Bypass -File ".\Setup RWANG HTTPS.ps1"
```

สคริปต์สร้าง local CA และ server certificate ชั่วคราวใน Current User certificate store, เชื่อถือเฉพาะ public CA บน Windows, สร้าง PFX ที่ `certs\` และเขียน `.env` โดยไม่ส่ง private key ออกนอกเครื่อง หลัง export สำเร็จ signing key ของ CA และสำเนา server key ใน `CurrentUser\My` จะถูกลบ เหลือ server key เฉพาะใน PFX ที่ถูก ignore จาก Git จากนั้น:

1. ติดตั้งเฉพาะ `certs\rwang-local-ca.cer` เป็น trusted root บนโทรศัพท์
2. บน iOS ให้เปิด Certificate Trust Settings และ Full Trust สำหรับ RWANG Local CA; Android ให้ติดตั้งเป็น CA certificate ตามนโยบายของเครื่อง
3. ห้ามคัดลอก `rwang-server.pfx`, `.env` หรือ `RWANG_TLS_PASSPHRASE` ไปยังมือถือ
4. เปิด `Start RWANG.cmd` ใหม่ แล้วใช้ Mobile URL ที่แสดงใน Settings > Mobile

ถ้า IP ของเครื่องเปลี่ยน ให้ทำ DHCP reservation หรือออก certificate ใหม่ด้วย `Setup RWANG HTTPS.ps1 -Force` แล้วติดตั้ง CA ชุดใหม่บนมือถือ โหมด `-Force` ลบ trust anchor ชุดเดิมด้วย thumbprint ที่สคริปต์บันทึกไว้ก่อนออกชุดใหม่ จึงไม่สะสม RWANG CA เก่า การสร้างและ import certificate ใช้ PowerShell PKI ของ Windows; ไฟล์ `.cer` ที่ export ไม่มี private key

## เสียงและข้อจำกัดบนมือถือ

RWANG ใช้ Web Speech API ของ browser สำหรับรับเสียง และใช้ speech synthesis ของอุปกรณ์สำหรับอ่านคำตอบ การรู้จำเสียงอาจส่งข้อมูลไปยังบริการของผู้ผลิต browser/ระบบปฏิบัติการ จึงไม่รับประกันว่า STT จะทำงานแบบ offline หรืออยู่ในเครื่องทั้งหมด

RWANG ไม่เปิดหน้า LAN HTTP เป็นค่าเริ่มต้น เพราะ browser มือถือส่วนใหญ่ต้องการ secure context สำหรับไมโครโฟนและ PWA และ HTTP ไม่ป้องกันการดัก credential/signaling ใช้ native HTTPS จากสคริปต์ด้านบน ส่วน `localhost` บนเครื่องหลักยังใช้งานไมค์ได้ตามสิทธิ์ของ browser

`RWANG_PUBLIC_ORIGIN` ใช้สำหรับประกาศ URL ของ native HTTPS listener เท่านั้น ไม่ถือว่า HTTPS เพียงเพราะ proxy ส่ง URL ภายนอกมา และ server จะปฏิเสธ public origin บน plaintext/loopback proxy mode การจับคู่อุปกรณ์ตรวจ `req.socket.encrypted` ของคำขอจริง แนวทางนี้ตั้งใจปิดความเสี่ยงที่ reverse proxy ซึ่งตั้งค่าผิดจะถูกนับเป็นเครื่องหลัก

## Perception: gesture, face และ voice profile

หน้า Loadout > Perception เปิดกล้องต่อเมื่อผู้ใช้กด START SENSORS เท่านั้น MediaPipe runtime และโมเดลอยู่ใน `public/vendor/` และทำ inference ใน browser โดยไม่ใช้ CDN runtime

- ฝ่ามือ: Assistant
- ชี้นิ้ว: Systems
- ชูสองนิ้ว: Loadout
- โป้งขึ้น/ลง: เลื่อนหน้า
- กำมือ: หยุดคำตอบ/เสียงที่กำลังเล่น

Face Profile และ Voice Profile เป็นการเทียบ template แบบทดลองที่เก็บใน `localStorage` ของอุปกรณ์นั้น มีปุ่มล้างข้อมูลใน Settings > Perception ข้อมูลนี้ใช้แสดงสถานะสะดวกเท่านั้น ไม่ใช่ authentication factor, ไม่แทน RWANG access token และไม่สามารถกด approval แทนผู้ใช้ได้ ส่วน Speech Recognition ใช้ API ของ browser และอาจไม่เป็น on-device ตามที่อธิบายในหัวข้อเสียง

## Screen share และ Mobile Remote

เครื่องหลักกด START SHARE แล้ว browser จะให้เลือก tab, application/window หรือทั้งหน้าจอ การเลือกของ browser เป็นตัวตัดสินสุดท้ายและ RWANG ไม่สามารถเริ่มแชร์แบบเงียบได้ จากนั้นกด COPY PRIVATE VIEW LINK เพื่อส่งลิงก์ให้มือถือใน LAN เดียวกัน

ลิงก์แชร์เก็บ one-time `shareToken` ไว้ใน URL fragment จึงไม่ถูกส่งไปยัง HTTP/proxy/service-worker token หมดอายุใน 5 นาทีและใช้ JOIN ได้ครั้งเดียว จากนั้นแลกเป็น `viewerToken` เฉพาะผู้ชม ลิงก์ที่ใช้แล้วจะ copy ซ้ำไม่ได้; เครื่องหลักต้องกดสร้าง invite ใหม่ Host ต้องเลือก viewer ที่จะควบคุมก่อน และ server เป็นผู้บังคับหมดอายุ Safe Remote ภายใน 10 นาทีแม้แท็บถูก sleep/throttle ผู้ชมอื่นไม่ได้สิทธิ์ตามไปด้วย ปุ่ม DISCONNECT ตัด viewer และ stream จริง คำสั่งจำกัดอยู่ที่ navigation/scroll/spotlight ภายในหน้า RWANG และถูก revoke ทันทีเมื่อ host event stream หลุด ระบบนี้ไม่ใช่ Windows Remote Desktop และไม่มี native keyboard/mouse injection

ค่าเริ่มต้น WebRTC ใช้ direct ICE สำหรับ LAN หากเครือข่ายแยก VLAN, ใช้ CGNAT หรือ firewall บล็อก UDP ให้ตั้ง `RWANG_ICE_SERVERS_JSON` ใน `.env` ตามตัวอย่างใน `.env.example` เพื่อเพิ่ม STUN/TURN ควรใช้ `turns:` และ credential อายุสั้นจาก TURN server ที่ควบคุมเอง; credential จะส่งเฉพาะ host/viewer ที่ผ่าน scoped session API

## Schedules

สร้าง routine จาก Loadout โดยกำหนดชื่อ เวลา repeat และ prompt เมื่อถึงเวลา RWANG จะแสดงสถานะ DUE แต่ไม่ดำเนิน external action เอง ผู้ใช้ต้องกด RUN เพื่อส่ง prompt เข้า Assistant การเรียก Home Assistant, webhook หรือ MCP ที่เกิดจาก prompt นั้นยังสร้าง approval card ตามปกติ Schedule ที่พลาดเวลาสามารถตั้งให้รอรอบเปิดครั้งถัดไปหรือข้ามได้

## Home Assistant

เปิด Settings > Home Assistant แล้วใส่ Base URL และ long-lived access token การเชื่อมต่อและเรียก REST API เกิดใน backend; token ถูกเก็บในไฟล์ local และจะไม่ถูกส่งกลับมาแสดงในหน้าเว็บหลังบันทึก

RWANG อนุญาตให้อ่าน entity ได้ทันที แต่คำสั่ง service ที่เปลี่ยนสถานะต้องปรากฏเป็น approval card และรอผู้ใช้กดอนุมัติก่อนเสมอ งานที่มีความเสี่ยงสูง เช่น lock, alarm, cover และ siren จะถูกระบุเป็น high risk ควรสร้าง token ของ Home Assistant ด้วยสิทธิ์เท่าที่จำเป็นเท่านั้น

## MCP Agents

เพิ่ม MCP server ได้จาก Settings > MCP Agents:

- `http` สำหรับ Streamable HTTP
- `sse` สำหรับ MCP SSE รุ่นเดิม
- `stdio` สำหรับ process ที่รันบนเครื่องเดียวกับ RWANG

ครั้งแรกต้องกด Trust เพื่อบันทึก fingerprint ของรายการและ schema เครื่องมือ หาก server เพิ่มหรือแก้ tool definition RWANG จะบล็อกการใช้งานจนกว่าจะตรวจและ Trust ใหม่ นอกจากนี้ทุก MCP tool call ยังต้องผ่าน approval card ก่อน execute อีกชั้นหนึ่ง ควรเชื่อมเฉพาะ server ที่ไว้ใจได้ โดยเฉพาะ stdio เพราะ command จะทำงานด้วยสิทธิ์ของบัญชี Windows ที่เปิด RWANG

## IoT Webhooks

เพิ่ม endpoint และ optional headers ได้จาก Settings > IoT Webhooks ค่า URL/headers ถูกเก็บฝั่ง backend และทุก request ต้องได้รับการอนุมัติใน UI ก่อนส่งจริง ใช้ endpoint ภายในเครือข่ายหรือ HTTPS ที่ไว้ใจได้ และออก credential แบบจำกัดสิทธิ์สำหรับ RWANG โดยเฉพาะ

## Mobile access และ security model

หน้า Settings > Mobile จะแสดง trusted HTTPS URL กด CREATE PAIR CODE แล้วกรอกรหัส 8 หลักบนโทรศัพท์ภายใน 3 นาที รหัสใช้ได้ครั้งเดียวและ server ออก credential อายุ 30 วันเป็น `HttpOnly; Secure; SameSite=Strict` cookie โดยไม่เปิดเผย master token ต่อ JavaScript หรือมือถือ เครื่องหลักแสดงรายการอุปกรณ์และ revoke ได้รายเครื่อง; REVOKE ALL + ROTATE จะยกเลิกทุก device credential และ master token เดิม

- การเรียกจาก loopback (`127.0.0.1`/`::1`) ได้รับความเชื่อถือโดยตรง
- อุปกรณ์มือถือได้ scope เฉพาะ `status`, `chat`, `schedule` และ `remote`
- Device credential ไม่มีสิทธิ์ approve external action, สั่ง model/system action หรือแก้ integration
- การแก้ integration, Trust MCP และ rotate token ทำได้จากเครื่องหลักเท่านั้น
- Home Assistant, webhook และ MCP action ต้องผ่าน human approval ก่อน execute
- RWANG รองรับ PEM cert/key หรือ PFX โดยตรง และ fail closed เมื่อ TLS config ไม่ครบหรืออ่านไฟล์ไม่ได้
- Host header ต้องอยู่ใน loopback, LAN interface, `RWANG_PUBLIC_ORIGIN` หรือ `RWANG_ALLOWED_HOSTS`; origin ข้ามเว็บไซต์ถูกปฏิเสธ
- SSE หลักใช้ authenticated fetch header พร้อมจำกัดจำนวน connection/slow client; remote SSE ใช้ one-time ticket อายุ 30 วินาทีแทน bearer token ใน URL
- `RWANG_PUBLIC_ORIGIN` ต้องเป็น `https://` ที่ใช้ native TLS และไม่สามารถใช้ยกระดับ backend HTTP จาก reverse proxy
- Secret ถูกเก็บเป็นข้อความในเครื่อง ควรปกป้องบัญชี Windows และโฟลเดอร์โปรเจกต์ รวมถึงไม่แชร์ไฟล์ config/log โดยไม่ตรวจข้อมูลก่อน

ข้อจำกัดที่ตั้งใจคงไว้: browser ต้องให้ผู้ใช้เลือกและอนุญาตหน้าจอทุกครั้ง, Face/Voice Profile ไม่ถูกเลื่อนเป็น authentication เพราะยังไม่มี liveness/anti-spoofing, และเว็บไม่ inject mouse/keyboard/shell ของ Windows หากต้องการยืนยันตัวตนระดับ biometric ให้ต่อยอดด้วย passkey/Windows Hello แทนการใช้ template ทดลอง

## ไฟล์ local ที่ไม่ขึ้น Git

ไฟล์ต่อไปนี้ถูกระบุใน `.gitignore`:

- `.rwang-config.json` — access token, Home Assistant token, MCP headers/commands และ webhook headers
- `.rwang-tool-fingerprints.json` — baseline fingerprint ของ MCP tools
- `.queue-state.json` — สถานะคิวดาวน์โหลด Ollama
- `.env`, `certs/`, `*.key`, `*.pem`, `*.pfx`, `*.log`, `node_modules/` และ `.pnpm-store/`

ใช้ `.rwang-config.example.json` และ `.env.example` เป็นตัวอย่างได้ แต่อย่านำ secret จริงไปใส่ในไฟล์ตัวอย่างหรือ commit ขึ้น repository

## คำสั่งสำหรับนักพัฒนา

```powershell
pnpm install      # ติดตั้ง dependencies
pnpm start        # เปิด RWANG server
pnpm check        # ตรวจ syntax ของ server, agent, remote และ perception scripts
pnpm test:security # ตรวจ pairing, token scope, remote grant และ invite replay
```

## เตรียม GitHub

โปรเจกต์ใช้ branch `main` มี `.gitattributes`, `.gitignore` และ GitHub Actions สำหรับตรวจ syntax แล้ว ก่อน commit ครั้งแรกให้ตั้ง Git identity หากเครื่องยังไม่มีค่า:

```powershell
git config --global user.name "YOUR NAME"
git config --global user.email "you@example.com"
git add .
git commit -m "feat: initialize RWANG local assistant"
```

สร้าง repository เปล่าชื่อ `rwang-local-assistant` บน GitHub โดยยังไม่เพิ่ม README/.gitignore จากหน้าเว็บ แล้วเชื่อมและ push:

```powershell
git remote add origin https://github.com/USERNAME/rwang-local-assistant.git
git push -u origin main
```

หากใช้ SSH ให้เปลี่ยน remote เป็น `git@github.com:USERNAME/rwang-local-assistant.git` และตรวจด้วย `git remote -v` ก่อน push
