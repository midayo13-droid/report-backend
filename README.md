# report-backend · 모아뷰티 일일 보고서 자동화 (서버)

판매처·광고·재고 데이터를 모아 일일·주간·월말 보고서를 만들고, 승인 규칙을 서버에서 지키는 API 서버예요. (NestJS + PostgreSQL)
화면은 짝이 되는 저장소 **report-frontend** 에 있어요.

> 모든 회사, 사람, 숫자는 **과제용 가상 데이터**예요. 실제 개인정보, 결제, 의료 정보는 쓰지 않아요.

## ⚠ 무료 서버라 첫 접속이 느릴 수 있어요

이 서버는 Render **무료(Free) 서버**에 올리는 것을 전제로 해요. 무료 서버는 일정 시간(보통 15분) 접속이 없으면 **잠들어요.**

- 잠든 뒤 **첫 접속은 보통 1분 안팎** 걸려요. 그동안 화면이 "확인하고 있어요"에서 멈추거나 오류처럼 보일 수 있어요. 잠시 기다렸다가 **새로고침**하면 돼요.
- 서버가 잠든 동안에는 **자동 수집·보고서 자동 생성(07:30, 09:05, 09:10, 15:00)이 돌지 않아요.** 시연할 때는 관리자 계정의 **시연 메뉴**에서 직접 실행하세요.
- 시연이나 발표 5분 전에 서버 주소(`/api/health`)를 한 번 열어 두면 미리 깨울 수 있어요.
- Render 무료 DB를 쓰면 일정 기간 뒤 만료될 수 있어요. 요금제 정책을 확인하세요.

## 한눈에 보기

| 항목 | 내용 |
|---|---|
| 기술 | NestJS 12, TypeScript, PostgreSQL(pg), JWT 로그인, pdfmake(PDF), OpenAI(AI 제안) |
| 서버 주소 | `https://(내 서비스 이름).onrender.com/api/...` |
| 상태 확인 | `GET /api/health` → `{"ok":true, ...}` |
| 자동 실행 (한국 시간) | 07:30 판매·광고 수집, 09:05 오전 재고, 09:10 보고서 생성, 15:00 오후 재고 |
| 데이터 저장 | 한 DB 안의 **전용 스키마(기본 `moa`)** 에만 만들어요. 다른 스키마는 건드리지 않아요. |
| AI | GPT를 쓰고, 키가 없거나 호출이 실패하면 미리 정한 규칙(모의 응답)으로 대신해요. |

## 설정값 (환경변수)

값은 **Render 화면(Environment)** 에 직접 넣어요. 이 저장소에는 값을 올리지 않아요. 파일 예시는 `.env.example` 이에요.

| 이름 | 뜻 | 꼭 필요? | 어떻게 정하나요 |
|---|---|---|---|
| `DATABASE_URL` | PostgreSQL 접속 주소 | **필수** | Render의 **External Database URL** 을 그대로 붙여 넣어요. (같은 지역의 Render 서버끼리는 Internal URL도 돼요) |
| `DB_SCHEMA` | 앱 테이블을 만들 스키마 이름 | 선택 (기본 `moa`) | 그대로 `moa` 를 권해요. 다른 프로젝트 데이터와 섞이지 않아요. |
| `JWT_SECRET` | 로그인 토큰을 서명하는 비밀 값 | **필수** | 길고 무작위인 글자. `render.yaml` 로 만들면 자동으로 생겨요. |
| `ENCRYPTION_KEY` | 연결 키를 암호화하는 비밀 값 | **필수** | **16진수 64자리.** 만들기: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `FRONTEND_ORIGIN` | 서버에 접속해도 되는 화면 주소 (CORS) | **필수** | Vercel 주소. 예: `https://report-frontend.vercel.app` (여러 개는 쉼표로 구분, 끝에 `/` 없이) |
| `GPT_API_KEY` | AI 제안 기능에 쓰는 OpenAI 키 | 선택 | 비워 두면 AI가 미리 정한 규칙으로 대신 답해요. |
| `GPT_MODEL` | 쓸 AI 모델 이름 | 선택 | 비워 두면 쓸 수 있는 모델을 자동으로 골라요. |
| `DEMO_MODE` | 시연 기능 켜기 (`true` / `false`) | 선택 | `true` 면 로그인 화면의 **시연 계정 버튼**과 **시연 메뉴**가 나와요. |
| `DEMO_PASSWORD` | 시연 계정의 비밀번호 | 선택 | 비워 두면 기본값을 써요. (프론트엔드 README 참고) |
| `SEED_ON_START` | 처음 켤 때 DB가 비어 있으면 가상 데이터를 채울지 (`true` / `false`) | 선택 | 처음 한 번은 `true`. 이미 데이터가 있으면 다시 채우지 않아요. |
| `ENABLE_SCHEDULER` | 정해진 시각의 자동 실행 켜기 | 선택 (기본 `true`) | `false` 로 끌 수 있어요. |
| `PORT` | 서버 포트 | 넣지 않아도 돼요 | Render가 알아서 정해 줘요. (로컬 기본 4000) |
| `NODE_VERSION` | Render가 쓸 Node 버전 | 권장 | `24` (이 저장소의 `.node-version` 과 같아요) |
| `SEED_TODAY` | 시연 날짜를 미리 맞출 때만, **한 번만** 붙여서 쓰는 값 | **서버 설정에는 넣지 마세요** | 예: `SEED_TODAY=2026-11-11 npm run seed:reset` |

## Render에 올리기

저장소 루트에 `render.yaml`(Blueprint)이 있어요. 두 가지 방법 중 하나로 하면 돼요.

### 방법 A. Blueprint로 한 번에 (권장)
1. Render 대시보드에서 **New → Blueprint** 를 고르고 이 저장소(`report-backend`)를 연결해요.
2. 비밀 값 입력칸이 나오면 `DATABASE_URL`, `ENCRYPTION_KEY`, `FRONTEND_ORIGIN`, (선택) `GPT_API_KEY` 를 넣어요.
3. **Apply** 를 누르면 만들고 배포해요.

### 방법 B. 직접 만들기 (Web Service)
**New → Web Service** 에서 이 저장소를 고르고 아래처럼 넣어요.

| 칸 | 넣을 값 |
|---|---|
| Language / Runtime | `Node` |
| Root Directory | 비워 둠 |
| **Build Command** | `npm install --include=dev && npm run build` |
| **Start Command** | `npm run start:prod` |
| Instance Type | `Free` |
| Health Check Path | `/api/health` |
| Environment | 위 "설정값" 표의 값 |

> 빌드 명령에 `--include=dev` 를 넣은 이유: 서버를 만드는 도구(NestJS CLI, TypeScript)가 개발용 패키지에 들어 있어서, 빠지면 빌드가 실패할 수 있어요.

### 배포 뒤 확인
1. 서버 주소 + `/api/health` 를 열어요. `{"ok":true, ...}` 가 나오면 정상이에요. (첫 접속은 느릴 수 있어요)
2. **처음 켜는 DB가 비어 있으면** 가상 데이터(90일치)를 채우느라 약 1분이 더 걸려요. 로그에 "가상 데이터를 채웠어요"가 나오면 끝이에요.
3. 이미 데이터가 있는 DB(`moa` 스키마)에 연결하면 다시 채우지 않고 그대로 써요.
4. 화면 쪽에서 이 서버 주소를 `NEXT_PUBLIC_API_URL` 로 넣고, 이 서버의 `FRONTEND_ORIGIN` 에는 화면 주소를 넣으면 서로 연결돼요.

### 시간대 주의
Render 서버는 보통 **UTC 시간**을 써요. 자동 실행 시각은 한국 시간으로 정해져 있지만, "오늘" 날짜는 서버 시계를 따라서 **한국 시간 오전 9시 전에는 하루 전 날짜**로 보일 수 있어요. 시연 데이터를 "처음 상태로 되돌릴" 때는 한국 시간 **오전 9시 이후**에 하세요.

## 내 컴퓨터에서 실행하기

```bash
npm install
cp .env.example .env      # 값을 채워요 (DATABASE_URL, JWT_SECRET, ENCRYPTION_KEY 는 꼭)
npm run build
npm run start             # http://localhost:4000/api/health
```

| 명령 | 하는 일 |
|---|---|
| `npm run start:dev` | 코드를 고치면 자동으로 다시 켜지는 개발용 실행 |
| `npm run seed` | DB가 비어 있을 때만 가상 데이터 채우기 |
| `npm run seed:reset` | 우리 스키마(`moa`)만 지우고 가상 데이터를 처음 상태로 다시 채우기 |
| `npm run db:inspect` | DB 상태를 읽기만 해서 보기 |

## 지키는 규칙 (서버가 강제)

- 기준 변경은 **내일부터** 적용돼요. (당일 적용 불가)
- 승인되어 공개된 보고서는 **고칠 수 없어요.** (DB 트리거로도 막아요)
- 승인된 기준 버전은 고치거나 지울 수 없어요.
- 역할(조회자·사용자·관리자·총관리자)에 맞지 않는 요청은 서버가 막아요.
- AI는 제안과 초안까지만 하고, 숫자는 시스템이 계산해요.

## 문서

| 문서 | 내용 |
|---|---|
| [docs/기획서.md](docs/기획서.md) | 고객과 배경, 현재 업무 분석(As-Is), 개선 설계(To-Be), 화면·DB·규칙·기능·완료 기준 |
| [docs/모아뷰티_보고서자동화_고객안내.pdf](docs/모아뷰티_보고서자동화_고객안내.pdf) | 고객 안내 자료 (현재 분석 · 개선 설계 · 구현 결과 · 실행 방법, 자동화와 AI 강조) |

## 보안 안내

- **DB 주소, API 키, 비밀 값은 이 저장소에 올리지 않아요.** `.env` 는 `.gitignore` 로 막혀 있어요.
- 키나 비밀번호를 채팅이나 문서에 붙여 넣은 적이 있다면, 쓰기 전에 **새로 발급**하세요.
- `DEMO_MODE=true` 는 비밀번호 없이 들어가는 시연 계정을 열어요. 가상 데이터로 시연할 때만 켜고, 실제 서비스에서는 꺼요.
