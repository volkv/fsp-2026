# Технологии, версии и лицензии

## Стек по уровням

| Уровень | Технологии |
|---|---|
| Интерфейс | SvelteKit 2 и Svelte 5 (runes), TypeScript в строгом режиме, Tailwind CSS 4, компоненты shadcn-svelte, иконки Lucide; шрифты Inter, JetBrains Mono и TDAText — акцентный шрифт брендбука ФСП для крупных чисел (OFL-1.1) |
| Сервер | Node 24, adapter-node; Zod 4 — схемы запросов, ответов, окружения и документа OpenAPI 3.1; `openid-client` — протокол OIDC для ФСП ID; Argon2id (`@node-rs/argon2`) — пароли; `node:crypto` — AES-256-GCM, HMAC-SHA-256, Ed25519; PDFKit — PDF-профиль кандидата |
| Хранение | PostgreSQL 17 с pgvector, Drizzle ORM и drizzle-kit (миграции), драйвер postgres.js; Valkey (совместим с Redis), клиент `redis`; S3-совместимое хранилище SeaweedFS |
| Фоновые задания | очередь в PostgreSQL (`FOR UPDATE SKIP LOCKED`, аренда с пульсом, повторы с паузой), отдельный процесс-воркер с планировщиком на advisory lock |
| Сервисы | `docparse` — Python 3.13, Starlette и uvicorn, pdfplumber, python-docx, LibreOffice headless, Tesseract; песочница — go-judge с Python, Node (JavaScript, TypeScript), Go, g++, Java, Kotlin; имитатор ФСП — Node 24 и `oidc-provider`; шлюзы — nginx; почта стенда — Mailpit |
| Модели | `extract` (разбор резюме, потребности, вставленной вакансии) по умолчанию — внешняя модель Claude Sonnet (Anthropic) через OpenAI-совместимый шлюз; заменяется без правки кода, переменными `LLM_*`, на свою модель Qwen3-8B-AWQ в рантайме vLLM на одной видеокарте (текст не покидает платформу) или на любой OpenAI-совместимый API с JSON-режимом; `rerank` — bge-reranker-v2-m3 в vLLM, необязателен; `embed` — bge-m3 Q8_0 в llama.cpp server на CPU. Режимы и куда уходят данные — `docs/models.md` |
| Проверки | ESLint, Prettier, svelte-check, Vitest (unit и integration на Testcontainers), Playwright с проверкой доступности axe; для Python — ruff и pytest |
| Документация | pandoc, mermaid-cli, Chromium из Playwright |
| Развёртывание | Docker и Docker Compose v2 |

## Лицензия решения и компонентов

Код решения открыт по лицензии **MIT** (`LICENSE`) и поставляется исходниками без сборки и обфускации; товарные знаки и логотипы
ФСП, шрифты и сторонние компоненты перечислены в `NOTICE`.

Сторонние компоненты допускаются только под разрешительными лицензиями, которые ТЗ называет прямо (MIT, Apache-2.0, семейство
BSD), и равными им по условиям (ISC, 0BSD, MIT-0, Unlicense, PSF-2.0, OFL-1.1 для шрифтов). Компонент с другой лицензией
допускается только **явным исключением с причиной**: например, LibreOffice (MPL-2.0) и JDK (GPL-2.0 с Classpath exception)
запускаются отдельными процессами без изменений и не связываются с кодом продукта, а MPL-2.0 у пакета проверки доступности
касается только тестов. Сильного копилефта, связанного с кодом продукта, нет.

Таблица ниже не пишется руками: `pnpm docs:licenses` (и сборка документации) собирает её из `pnpm-lock.yaml`, `uv.lock` сервисов,
compose-файлов и Dockerfile, а лицензии, которых нет в файлах зависимостей (Python-пакеты, образы, пакеты ОС, модели, шрифты), —
из реестра с источником каждой записи. Компонент без записи, лицензия вне разрешённого списка без исключения или исключение,
которое больше ни к чему не относится, останавливают сборку — новая зависимость не может появиться в продукте незамеченной.
