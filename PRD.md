# Product Requirements Document (PRD)

## `mengcli` — Autonomous AI Multi-Agent CLI Suite

**Studio:** Menglabs

**Versi Dokumen:** 1.0.0

**Status:** *Ready for Implementation*

---

## 1. Executive Summary & Overview

### 1.1 Apa itu `mengcli`?

`mengcli` adalah perangkat lunak *Command Line Interface* (CLI) lokal berbasis *Multi-Agent Architecture* yang dirancang untuk bertindak sebagai **Autonomous AI Software Agency**. `mengcli` mendelegasikan tugas-tugas pengembangan perangkat lunak yang kompleks ke dalam divisi-divisi spesialis AI yang bekerja secara asinkron di latar belakang menggunakan *Tmux*, dikendalikan jarak jauh melalui *Telegram Bot*, dan terhubung ke ekosistem luar menggunakan standar *Model Context Protocol (MCP)*.

### 1.2 Tujuan Utama (Objectives)

* **Zero Human-in-the-Loop (Default):** Memungkinkan pengerjaan tugas besar dari terminal tanpa harus mengawasi setiap baris kode secara langsung.
* **Safe Autonomy:** Dilengkapi sistem *Circuit Breaker*, *File Locking*, dan *Token Budgeting* untuk mencegah kerusakan sistem atau pembengkakan biaya API.
* **Professional Handoff:** Menghasilkan keluaran berupa Git Branch dan *Local Pull Request* yang bersih, bukan menimpa kode secara sembarangan.

---

## 2. System Architecture & Component Mapping

Arsitektur `mengcli` dibagi menjadi 5 lapisan utama:

```
[ User Input (CLI / Telegram / Web UI) ]
                   │
                   ▼
       [ Command Center & Router ]
                   │
      ┌────────────┴────────────┐
      ▼                         ▼
[ Web UI Onboarding ]    [ Tmux Background Runner ]
                                │
          ┌─────────────────────┼─────────────────────┐
          ▼                     ▼                     ▼
   [ Team Planner ] ──> [ Team Dev / Migration ] ──> [ Team QA / Security ]
          │                     │                     │
          └─────────────► [ MCP & Local Skills ] <────┘

```

1. **Interface Layer:** CLI Utama (`mengcli`), Web UI Lokal (Onboarding & Konfigurasi), dan Telegram Bot (Remote Control & Notifikasi).
2. **Orchestration Layer:** *Team Planner* yang memecah tugas menjadi *Directed Acyclic Graph* (DAG) dan mengatur giliran agen.
3. **Execution & Tooling Layer:** Divisi spesialis (Dev, Riset, Migration, QA, Security) yang dilengkapi file `SKILL.md` dan integrasi *Model Context Protocol* (MCP).
4. **Safety & Guardrail Layer:** *Circuit Breaker*, *Token Budgeting*, *File Locking*, dan *Stateful Pause* (Menunggu Input).
5. **Persistence & Delivery Layer:** Audit Logs (`mengcli trace`), *Sandbox Workspace* (`.agent_workspace/`), dan *Local Git PR*.

---

## 3. Detailed Functional Requirements

### 3.1 Onboarding & Konfigurasi (Web UI)

* **Perintah:** `mengcli config` atau `mengcli init`.
* **Mekanisme:**
* Mendeteksi apakah file konfigurasi di `~/.config/mengcli/config.yaml` sudah ada.
* Jika belum (atau dipanggil manual), menyalakan peladen web lokal sementara yang *bind* secara ketat ke `127.0.0.1` (mencari port kosong secara dinamis jika port bentrok).
* Membuka *browser* otomatis ke halaman Web UI.


* **Fitur Web UI:**
* Input global *Base URL* dan *API Key*.
* Dropdown *Model Routing* per tim (Contoh: Planner menggunakan model besar, QA menggunakan model cepat/murah).
* Pengaturan Token Bot & Chat ID Telegram.
* Manajemen Server MCP (menambahkan server via stdio/HTTP).


* **Penutupan:** Tombol "Simpan" menulis konfigurasi ke `config.yaml` dan mematikan peladen web secara otomatis (*graceful shutdown*).

* **Autentikasi Peladen Lokal:** *Bind* ke `127.0.0.1` saja tidak cukup — proses lokal manapun milik pengguna dapat menjangkaunya dan mencuri API Key. Karena itu:
  * Saat dinyalakan, peladen membangkitkan token acak (`crypto.randomUUID()`) dan membuka *browser* ke `http://127.0.0.1:<port>/?t=<token>`.
  * Setiap request wajib menyertakan token tersebut; request tanpa token dijawab `401` tanpa penjelasan.
  * Header `Origin` diverifikasi pada seluruh request bermetode `POST` untuk menangkal serangan lintas situs dari *browser* pengguna sendiri.
  * Token hangus setelah peladen mati. Peladen juga mati sendiri setelah 15 menit tanpa aktivitas.

* **Mode Non-Interaktif (MVP):** Pada rilis MVP (Bagian 14), konfigurasi dilakukan melalui serangkaian pertanyaan di terminal. Web UI menyusul pada v1.1 tanpa mengubah skema `config.yaml`.

### 3.2 Tim Spesialis & Sistem `SKILL.md`

Setiap tim memiliki direktori khusus di `~/.config/mengcli/skills/[team_name]/SKILL.md` yang memuat identitas, batasan, dan instruksi operasional:

1. **Team Planner:** Arsitek utama. Memecah *prompt* pengguna menjadi langkah kerja dan memilih model cerdas.
2. **Team Riset:** Penjelajah kode. Membaca struktur file menggunakan alat seperti `ripgrep` (`rg`) dan `fd`.
3. **Team Dev:** Eksekutor utama. Menulis dan memodifikasi kode di ruang karantina (`.agent_workspace/`).
4. **Team Migration:** Spesialis database dan skema (`dbmate`, `golang-migrate`).
5. **Team Security:** Auditor paranoid. Memindai kerentanan kode (`semgrep`) dan mencegah kebocoran rahasia (`gitleaks`).
6. **Team QA:** Penguji kualitas. Memvalidasi hasil kerja dan mensimulasikan tes.

### 3.3 Background Execution (Tmux Integration)

* Setiap tugas besar yang dikirimkan tidak berjalan di terminal aktif pengguna, melainkan dilempar ke sesi Tmux terisolasi berstatus *detached*.
* Memastikan tugas tetap berjalan meskipun laptop masuk ke mode *Lock Screen* atau terminal ditutup.

### 3.4 Remote Operations (Telegram Bot Integration)

* **Keamanan:** Bot wajib memvalidasi *Chat ID* pengirim; abaikan semua pesan dari ID di luar daftar putih.
* **Fungsi:**
* Menerima notifikasi status tugas (Selesai, Gagal, atau *Paused*).
* Menerima *Distress Flare* saat agen kebingungan (*Stateful Pause*). Pengguna dapat membalas (*reply*) pesan di Telegram untuk memasukkan instruksi klarifikasi.
* Tombol interaktif (*Inline Keyboard*) untuk memantau log, menghentikan tugas (*Circuit Breaker* manual), atau melihat ringkasan diff.



### 3.5 Model Context Protocol (MCP) Support

* Memungkinkan agen berinteraksi dengan sumber eksternal (GitHub, Database, Filesystem eksternal) secara standar.
* Dikonfigurasi melalui Web UI dan disimpan dalam blok `mcp_servers` pada file konfigurasi lokal. Agen membaca kemampuan MCP langsung melalui definisi alat (*tool call*) yang diteruskan ke LLM.

---

## 4. Guardrails & Safety Mechanisms (The 3 Critical Conditions)

Sesuai komitmen arsitektur, `mengcli` dilengkapi tiga pilar pengaman mutlak:

### 4.1 File Locking (Mencegah Konflik Antar-Agen)

* **Mekanisme:** Sebelum divisi manapun (Dev atau Migration) melakukan *patch* atau tulis pada sebuah file, sistem akan mendaftarkan *lock* pada direktori `.agent_workspace/.locks/`.
* **Aturan:** Jika file `X` sedang dikunci oleh Team Dev, Team Migration yang mencoba mengakses file yang sama akan dimasukkan ke dalam antrean (*queue*) atau ditolak sementara hingga kunci dilepas, mencegah korupsi data (*race condition*).

* **Pencegahan Deadlock (bukan deteksi):** Sistem tidak membangun detektor siklus. Sebagai gantinya, kondisi *hold-and-wait* dihapus sejak awal sehingga *deadlock* mustahil terjadi secara struktural:
  1. Agen wajib mendeklarasikan **seluruh** berkas yang akan disentuh sebelum mengunci satu pun.
  2. Kunci diambil berurutan menurut *lexicographic path*, bersifat *all-or-nothing*, dalam satu transaksi SQLite.
  3. Bila satu kunci saja gagal, seluruh kunci dilepas, agen menunggu dengan jeda acak, lalu mengulang.
  4. Agen yang butuh berkas di luar deklarasi awal harus melepas semuanya dan mengajukan kembali.

* **Kunci Yatim (*Stale Lock*):** Setiap baris `locks` memuat `pid` dan `expires_at`. Kunci dianggap gugur bila `expires_at` terlampaui **atau** proses pemegangnya sudah tidak hidup. Pemeriksaan dijalankan sebelum setiap upaya akuisisi, sehingga agen yang mati mendadak tak dapat membekukan sistem selamanya.

### 4.2 Token Budgeting & Cost Control

* **Mekanisme:** Setiap tugas diberi batasan kuota token (*Token Budget*) dan batas maksimal iterasi (misal: maks 15 iterasi / 50.000 token per tugas).
* **Aturan:** Jika agen terjebak dalam *looping* diskusi dan hampir melewati batas anggaran, sistem otomatis menarik rem tangan (*Circuit Breaker*), membekukan status, dan mengirim peringatan ke Telegram untuk mencegah pemborosan biaya API.

### 4.3 Centralized Audit Trace (`mengcli trace`)

* **Mekanisme:** Seluruh peristiwa sistem (perpindahan divisi, panggilan alat MCP, interaksi LLM, *error*, hingga *input* Telegram) dicatat secara terstruktur ke basis data SQLite di `~/.local/state/mengcli/mengcli.db` (lihat Bagian 9). Basis data ini merangkap sebagai penyimpan status tugas sehingga proses yang mati dapat dipulihkan.
* **Perintah CLI:** Pengguna dapat mengetik `mengcli trace [ID]` di terminal untuk membedah langkah demi langkah keputusan yang diambil oleh agen secara visual.

---

## 5. Workflow Siklus Hidup Tugas (Task Lifecycle)

1. **Inisiasi:** Pengguna memasukkan perintah di terminal (`mengcli run "buat fitur X"`) atau via Telegram.
2. **Perencanaan:** *Team Planner* mengevaluasi instruksi. Jika ragu, masuk ke status **Stateful Pause** dan bertanya ke pengguna. Jika jelas, menyusun peta jalan dan melemparkannya ke Tmux.
3. **Eksekusi Paralel (Background):**
* Riset membaca file.
* Dev menulis kode di `.agent_workspace/` dengan pengamanan *File Locking*.
* Security & QA memvalidasi hasil dengan batasan *Token Budget*.


4. **Handoff & Delivery:**
* Jika gagal/buntu: Memicu *Circuit Breaker* dan meninggalkan Laporan Otopsi.
* Jika sukses:
* Agen membuat *Git Branch* baru (misal: `mengcli/feat-x`).
* Menyusun *Local Pull Request* dan ringkasan diff.
* Mengirim notifikasi ke Telegram dengan opsi persetujuan (`[Merge]`, `[Tolak]`).





---

## 6. Technology Stack

### 6.1 Runtime

**Bun** (minimum `1.3.0`) sebagai runtime, package manager, test runner, dan bundler sekaligus. TypeScript dijalankan langsung tanpa langkah build terpisah.

Alasan pemilihan: sebagian besar kebutuhan infrastruktur `mengcli` sudah tersedia di dalam Bun, sehingga jumlah dependensi pihak ketiga dapat ditekan mendekati nol.

| Kebutuhan | Solusi | Dependensi |
| --- | --- | --- |
| Baca/tulis `config.yaml` | `Bun.YAML` | — |
| Penyimpanan API Key & Token Bot | `Bun.secrets` (Keychain / libsecret / CredMan) | — |
| Audit log & status tugas | `bun:sqlite` | — |
| Peladen Web UI onboarding | `Bun.serve` | — |
| Spawn Tmux & alat CLI | `Bun.spawn` / `Bun.$` | — |
| Panggilan LLM & Telegram Bot API | `fetch` bawaan | — |
| Pengujian | `bun:test` | — |
| Distribusi | `bun build --compile` (binary tunggal) | — |

### 6.2 Dependensi Pihak Ketiga

Hanya dua paket eksternal yang diizinkan pada v1:

1. `@modelcontextprotocol/sdk` — implementasi resmi MCP untuk transport stdio dan HTTP.
2. `zod` — validasi skema `config.yaml` dan argumen *tool call* dari LLM. Wajib karena keduanya merupakan masukan tak tepercaya.

Integrasi Telegram **tidak** menggunakan pustaka *wrapper*; cukup `fetch` terhadap Bot API dengan mekanisme *long polling*.

### 6.3 Konsekuensi Teknis yang Mengikat

* **SQLite wajib mode WAL.** Beberapa sesi Tmux menulis basis data yang sama secara bersamaan. `PRAGMA journal_mode = WAL` dan `PRAGMA busy_timeout = 5000` harus diterapkan pada setiap pembukaan koneksi.
* **Rujukan biner sendiri.** Proses induk yang menjalankan Tmux wajib memanggil `process.execPath` beserta lintasan berkas masuk, bukan `bun run <file>` (rinciannya pada Bagian 11.3).
* **Struktur direktori** mengikuti XDG Base Directory:
  * `~/.config/mengcli/` — `config.yaml` dan `skills/`
  * `~/.local/state/mengcli/` — `mengcli.db`
  * `<repo>/.agent_workspace/` — ruang kerja agen (lihat Bagian 10)

---

## 7. Configuration Schema

Berkas: `~/.config/mengcli/config.yaml`, permission wajib `0600`.

Berkas ini **tidak pernah** memuat kredensial. Setiap kredensial disimpan di *keychain* sistem melalui `Bun.secrets`; `config.yaml` hanya menyimpan nama rujukannya.

```yaml
config_version: 1

providers:
  # `secret_ref` merujuk pada entri di keychain sistem, bukan nilai kunci.
  default:
    base_url: https://api.anthropic.com/v1
    secret_ref: mengcli/provider/default
  fast:
    base_url: https://api.openai.com/v1
    secret_ref: mengcli/provider/fast

# Pemetaan tim ke model. Tim tanpa entri memakai `_default`.
model_routing:
  _default: { provider: default, model: claude-sonnet-4-6 }
  planner:  { provider: default, model: claude-opus-4-1 }
  riset:    { provider: fast,    model: gpt-4o-mini }
  dev:      { provider: default, model: claude-sonnet-4-6 }
  qa:       { provider: fast,    model: gpt-4o-mini }

budget:
  max_tokens_per_task: 50000
  max_iterations_per_task: 15
  max_tokens_per_day: 2000000     # rem tangan global lintas tugas
  max_concurrent_agents: 3

timeouts:
  llm_request_seconds: 120
  tool_call_seconds: 300
  stateful_pause_hours: 24        # pause tanpa jawaban akan dibatalkan
  file_lock_seconds: 600          # TTL lock; lihat Bagian 4.1

telegram:
  enabled: false
  token_ref: mengcli/telegram/token
  allowed_chat_ids: []            # kosong = seluruh pesan diabaikan
  require_confirmation_for: [merge, push, delete]

tools:
  # Daftar putih. Perintah di luar daftar ini ditolak tanpa negosiasi.
  allowed: [git, rg, fd, bun, npm, pnpm, go, cargo, make, dbmate, semgrep, gitleaks]
  denied_args:
    git: ["push", "reset --hard", "clean -fdx"]
  network_access: false           # agen tak boleh curl/wget kecuali via MCP

mcp_servers:
  - name: github
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    secret_ref: mengcli/mcp/github
    allowed_tools: ["search_repositories", "get_file_contents"]
    auto_approve: false           # true = jalankan tanpa konfirmasi pengguna
```

**Aturan validasi:**

* Berkas divalidasi dengan `zod` saat dimuat. Konfigurasi tak valid menggagalkan proses seketika dengan pesan yang menunjuk baris bermasalah — tidak ada mekanisme penambalan diam-diam.
* `config_version` tak dikenal akan menghentikan proses dan menyarankan perintah `mengcli config migrate`.
* Variabel lingkungan `MENGCLI_*` menimpa nilai berkas; berguna untuk CI dan pengujian.

---

## 8. Task State Machine

Status tugas disimpan pada tabel `tasks` (Bagian 9), bukan di memori, sehingga proses yang mati dapat dilanjutkan.

```
                    ┌──────────────────────────┐
                    ▼                          │
  PENDING ──► PLANNING ──► RUNNING ──► DELIVERED ──► MERGED
                 │            │  │                      
                 │            │  └──► PAUSED ───────────┘ (jawaban diterima)
                 │            │           │
                 │            │           └──► CANCELLED (timeout / pengguna)
                 │            │
                 └────────────┴──► FAILED ──► (autopsi ditulis)
```

| Status | Arti | Transisi keluar |
| --- | --- | --- |
| `PENDING` | Tugas tercatat, Tmux belum dijalankan | `PLANNING` |
| `PLANNING` | Planner menyusun DAG | `RUNNING`, `PAUSED`, `FAILED` |
| `RUNNING` | Agen bekerja di Tmux | `DELIVERED`, `PAUSED`, `FAILED` |
| `PAUSED` | Menunggu jawaban pengguna (*Stateful Pause*) | `RUNNING`, `CANCELLED` |
| `DELIVERED` | Branch dan *local PR* siap ditinjau | `MERGED`, `CANCELLED` |
| `MERGED` | Perubahan diterima pengguna | terminal |
| `FAILED` | *Circuit breaker* aktif; laporan otopsi tersedia | terminal |
| `CANCELLED` | Dihentikan pengguna atau kedaluwarsa | terminal |

**Pemulihan setelah crash:** saat dijalankan, `mengcli` memeriksa tugas berstatus `RUNNING` yang sesi Tmux-nya sudah tidak ada, lalu memindahkannya ke `FAILED` dengan alasan `orphaned` dan melepaskan seluruh *lock* yang dipegangnya.

---

## 9. Event Log & Database Schema

Berkas: `~/.local/state/mengcli/mengcli.db`.

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,          -- ULID
  prompt        TEXT NOT NULL,
  repo_path     TEXT NOT NULL,
  branch        TEXT,
  status        TEXT NOT NULL,             -- lihat Bagian 8
  tmux_session  TEXT,
  tokens_used   INTEGER NOT NULL DEFAULT 0,
  iterations    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,          -- epoch ms
  updated_at    INTEGER NOT NULL,
  finished_at   INTEGER
);

CREATE TABLE events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT NOT NULL REFERENCES tasks(id),
  ts         INTEGER NOT NULL,             -- epoch ms
  team       TEXT,                         -- planner | riset | dev | ...
  kind       TEXT NOT NULL,                -- lihat daftar di bawah
  summary    TEXT NOT NULL,                -- satu baris, tampil di `trace`
  payload    TEXT,                         -- JSON; detail lengkap
  tokens_in  INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER
);
CREATE INDEX idx_events_task ON events(task_id, ts);

CREATE TABLE locks (
  file_path  TEXT PRIMARY KEY,             -- relatif terhadap repo
  task_id    TEXT NOT NULL REFERENCES tasks(id),
  team       TEXT NOT NULL,
  pid        INTEGER NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL             -- acquired_at + file_lock_seconds
);

CREATE TABLE budget_ledger (               -- pemakaian token harian global
  day         TEXT PRIMARY KEY,            -- YYYY-MM-DD
  tokens_used INTEGER NOT NULL DEFAULT 0
);
```

**Nilai `events.kind` yang sah:**

`task.created`, `task.status_changed`, `team.handoff`, `llm.request`, `llm.response`, `llm.error`, `tool.call`, `tool.result`, `tool.denied`, `mcp.call`, `mcp.result`, `lock.acquired`, `lock.released`, `lock.denied`, `budget.warning`, `budget.exceeded`, `pause.requested`, `pause.resolved`, `telegram.inbound`, `telegram.outbound`, `git.branch`, `git.commit`, `circuit_breaker.tripped`

**Kebijakan rahasia:** `payload` melewati penyaring *redaction* sebelum ditulis. Pola yang menyerupai API key, token, dan header `Authorization` diganti menjadi `[REDACTED]`.

`mengcli trace [ID]` membaca tabel `events` secara berurutan. Tanpa argumen, perintah menampilkan tugas terakhir.

---

## 10. Workspace & Delivery Model

`.agent_workspace/` **bukan** salinan repositori. Setiap tugas memakai `git worktree` tersendiri:

```
<repo>/.agent_workspace/<task_id>/   → git worktree, branch mengcli/<slug>
```

Konsekuensi yang menguntungkan:

* Isolasi didapat gratis; direktori kerja pengguna tak pernah tersentuh.
* Diff, commit, dan *local PR* memakai perintah Git biasa tanpa lapisan sinkronisasi buatan.
* Pembersihan cukup `git worktree remove`.

`.agent_workspace/` wajib dimasukkan ke `.git/info/exclude` secara otomatis pada pemakaian pertama.

**Batasan Git:** agen boleh `commit` dan `branch`. Agen **tidak pernah** boleh menjalankan `push`, `merge`, `rebase`, atau `reset --hard`. Penggabungan hanya terjadi atas perintah eksplisit pengguna melalui `mengcli merge <id>` atau tombol `[Merge]` di Telegram, dan dijalankan oleh proses induk — bukan oleh agen.

---

## 11. Distribution & Installation

### 11.1 Sasaran

```bash
npm install -g mengcli
```

Perintah tunggal, tanpa langkah tambahan, tanpa mengharuskan pengguna memasang Bun terlebih dahulu.

### 11.2 Strategi: Bun sebagai Dependensi

Paket `mengcli` diterbitkan sebagai sumber TypeScript (~200 KB) dengan `bun` sebagai dependensi biasa. Paket `bun` di npm sudah memiliki 16 `optionalDependencies` per platform beserta skrip `postinstall`, sehingga npm hanya mengunduh biner untuk platform pengguna (~60 MB) secara otomatis.

```json
{
  "name": "mengcli",
  "version": "1.0.0",
  "bin": { "mengcli": "bin/mengcli.js" },
  "dependencies": {
    "bun": "^1.3.0",
    "@modelcontextprotocol/sdk": "^1.0.0",
    "zod": "^3.23.0"
  },
  "files": ["bin", "src", "skills"],
  "engines": { "node": ">=18" }
}
```

`bin/mengcli.js` adalah *shim* Node murni yang bertugas mencari biner Bun di `node_modules`, lalu menyerahkan proses kepadanya:

```js
#!/usr/bin/env node
const { spawnSync } = require("child_process");
const path = require("path");
const bun = require.resolve("bun/bin/bun");           // biner platform hasil postinstall
const entry = path.join(__dirname, "..", "src", "index.ts");
const r = spawnSync(bun, [entry, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
```

**Alasan memilih pendekatan ini** dibanding menerbitkan biner hasil `bun build --compile` per platform: pendekatan biner menuntut 5 paket npm terpisah, matriks CI lintas platform, dan ~61 MB artefak per target pada setiap rilis (terukur: 39 detik per target saat *cross-compile*). Ukuran unduh yang dirasakan pengguna sama saja, sementara beban rilis jauh lebih besar. Migrasi ke pendekatan biner tetap terbuka bila kelak waktu mula (*startup*) menjadi keluhan nyata.

### 11.3 Konsekuensi

* **Waktu mula bertambah ~35 ms** akibat lapisan *shim* Node. Dapat diabaikan untuk CLI yang pekerjaan utamanya men-*spawn* Tmux.
* **`postinstall` wajib berjalan.** Pemasangan dengan `--ignore-scripts` akan gagal; `bin/mengcli.js` harus mendeteksi kondisi ini dan menampilkan pesan perbaikan yang jelas.
* **Rujukan biner sendiri (revisi Bagian 6.3):** `process.execPath` menunjuk ke biner Bun, bukan ke `mengcli`. Saat men-*spawn* sesi Tmux, perintah yang benar adalah `process.execPath + <path src/index.ts>`, bukan `process.execPath` saja.
* **Windows tidak didukung pada v1** karena ketergantungan pada Tmux. Pemasangan di Windows harus gagal lebih awal dengan pesan yang menjelaskan alasannya.

### 11.4 Prasyarat Sistem

Diperiksa saat proses dimulai:

| Alat | Sifat | Perilaku bila absen |
| --- | --- | --- |
| `git` ≥ 2.20 | wajib | keluar dengan kode `5` beserta instruksi pemasangan |
| `tmux` ≥ 3.0 | wajib | keluar dengan kode `5` beserta instruksi pemasangan |
| `rg` | opsional | Team Riset beralih ke penelusuran bawaan, lebih lambat |
| `fd` | opsional | Team Riset beralih ke `Bun.Glob` |
| `semgrep` | opsional | Team Security dinonaktifkan disertai peringatan |
| `gitleaks` | opsional | pemindaian rahasia dinonaktifkan disertai peringatan |
| `dbmate` | opsional | Team Migration dinonaktifkan disertai peringatan |

Alat opsional yang absen **tidak boleh** menggagalkan proses. Ketiadaannya dicatat sebagai peristiwa `tool.denied` agar terlihat pada `mengcli trace`.

---

## 12. CLI Surface & Exit Codes

### 12.1 Perintah

| Perintah | Fungsi |
| --- | --- |
| `mengcli run "<prompt>"` | Membuat tugas baru dan melemparnya ke Tmux. Mencetak ID tugas lalu keluar |
| `mengcli status [id]` | Menampilkan tugas aktif; tanpa argumen menampilkan seluruhnya |
| `mengcli stop <id>` | *Circuit breaker* manual; mematikan sesi Tmux dan melepas seluruh kunci |
| `mengcli logs <id>` | Mengikuti keluaran mentah agen secara langsung (`--follow`) |
| `mengcli trace <id>` | Menampilkan riwayat keputusan agen langkah demi langkah dari tabel `events` |
| `mengcli diff <id>` | Menampilkan diff *worktree* terhadap cabang induk |
| `mengcli merge <id>` | Menggabungkan cabang tugas. **Hanya perintah ini yang boleh menggabungkan** |
| `mengcli reply <id> "<teks>"` | Menjawab tugas berstatus `PAUSED` dari terminal |
| `mengcli config` | Membuka konfigurasi (Web UI pada v1.1; prompt terminal pada MVP) |
| `mengcli init` | Menyiapkan `.agent_workspace/` dan `.git/info/exclude` pada repositori |
| `mengcli clean` | Menghapus *worktree* milik tugas berstatus terminal |

Flag `--json` berlaku global; setiap perintah wajib mampu mengeluarkan JSON agar dapat di-*script*.

### 12.2 Exit Codes

| Kode | Arti |
| --- | --- |
| `0` | Sukses |
| `1` | Galat umum |
| `2` | Konfigurasi tidak valid atau tidak ditemukan |
| `3` | Anggaran token terlampaui |
| `4` | *Circuit breaker* aktif |
| `5` | Prasyarat sistem tidak terpenuhi |
| `6` | Tugas tidak ditemukan |

### 12.3 Kebijakan Kegagalan LLM

* **Layak diulang:** `429`, `5xx`, `timeout`, dan kegagalan jaringan. Maksimum 3 upaya, *exponential backoff* dengan *jitter* (1 dtk, 2 dtk, 4 dtk), dan header `Retry-After` selalu dihormati bila tersedia.
* **Tidak layak diulang:** `400`, `401`, `403`, `404`. Langsung gagal disertai pesan yang dapat ditindaklanjuti.
* **Respons tak sesuai bentuk:** *tool call* yang gagal divalidasi `zod` memicu satu kali *reprompt* berisi galat validasi. Bila masih gagal, tugas berpindah ke `FAILED`.
* **Anggaran:** setiap upaya — termasuk pengulangan — dihitung ke dalam `tokens_used`. Tanpa aturan ini, mekanisme *retry* menjadi celah kebocoran biaya yang tak terpantau.
* Seluruh percobaan dicatat sebagai `llm.error` beserta nomor upaya pada `payload`.

---

## 13. Non-Goals

Batasan berikut mengikat untuk v1 dan berfungsi menjaga ruang lingkup tetap terkendali:

* **Bukan editor atau TUI interaktif.** `mengcli` melempar tugas lalu keluar; ia bukan tempat pengguna berdiam.
* **Tidak pernah menjalankan `git push`.** Seluruh keluaran bersifat lokal. Interaksi dengan repositori jarak jauh sepenuhnya menjadi wewenang pengguna.
* **Tidak menyentuh CI/CD.** Tidak memicu *pipeline*, tidak membaca statusnya.
* **Tidak melakukan *deployment*.** Tanpa integrasi Docker, Kubernetes, maupun penyedia awan.
* **Tidak mengelola kredensial awan.** Hanya kunci penyedia LLM dan token Telegram.
* **Tanpa dukungan Windows.** Bergantung pada Tmux.
* **Tanpa mode multi-pengguna atau layanan bersama.** Satu mesin, satu pengguna, seluruh status bersifat lokal.
* **Bukan tempat penyimpanan kode jangka panjang.** *Worktree* bersifat sementara dan dibersihkan setelah penggabungan.

---

## 14. Release Scope

### 14.1 MVP (v1.0)

Tujuan MVP adalah membuktikan lingkaran inti — *prompt* masuk, cabang Git keluar — dengan permukaan sekecil mungkin.

**Termasuk:**

* `run`, `status`, `stop`, `trace`, `diff`, `merge`, `clean`
* Team Planner, Team Riset, Team Dev
* Eksekusi latar belakang berbasis Tmux
* Isolasi berbasis `git worktree`
* Basis data SQLite: `tasks`, `events`, `locks`, `budget_ledger`
* Anggaran token dan *circuit breaker*
* Penguncian berkas beserta pencegahan *deadlock*
* Konfigurasi melalui prompt terminal; kredensial disimpan pada `Bun.secrets`
* Distribusi npm

**Tidak termasuk (dan alasannya):**

| Ditunda | Alasan |
| --- | --- |
| Web UI | Menuntut peladen HTTP, *frontend*, dan seluruh permukaan autentikasi. Prompt terminal memberi hasil setara pada tahap ini |
| Telegram Bot | Bernilai tinggi, namun bergantung pada lingkaran inti yang harus lebih dahulu terbukti |
| MCP | Menambah permukaan eksekusi kode pihak ketiga sebelum guardrail teruji |
| Team Migration | Memerlukan validasi skema basis data yang belum dirancang |
| Team Security | Bergantung pada `semgrep` dan `gitleaks` |
| Team QA | Mensyaratkan penemuan *test runner* lintas ekosistem |
| Eksekusi paralel | MVP menjalankan agen secara berurutan; penguncian tetap dibangun agar siap dipakai |

### 14.2 v1.1 — Remote & Konfigurasi

Web UI beserta autentikasi token, Telegram Bot, `logs --follow`, `reply`, dan *stateful pause*.

### 14.3 v1.2 — Kedalaman Kemampuan

MCP, Team Security, Team QA, Team Migration, serta eksekusi paralel dengan `max_concurrent_agents`.

### 14.4 Kriteria Keberhasilan MVP

* `npm i -g mengcli && mengcli run "..."` menghasilkan cabang yang dapat digabungkan pada repositori nyata.
* Tugas bertahan meski terminal ditutup dan layar terkunci.
* Tak satu pun tugas melampaui anggaran token tanpa memicu *circuit breaker*.
* Proses yang mati mendadak tidak pernah meninggalkan kunci yang membekukan sistem.
* `mengcli trace` menjelaskan setiap keputusan agen tanpa perlu membuka berkas log secara manual.

---

## 15. Project Identity & Branding

* **Nama Aplikasi:** `mengcli`
* **Sub-judul:** AI agent by Menglabs
* **Maskot ASCII Art (Ditampilkan saat CLI dinyalakan):**

```text
  /\_/\
 ( o.o )   mengCLI
  > ^ <    AI agent by Menglabs


```
