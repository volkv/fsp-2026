// Licence facts the build cannot read from the checkout: Python packages (uv.lock carries no licence), container images,
// operating system packages of our images, models, fonts and documentation tools. Each entry names where the licence
// was taken from; the generator fails on a component that has no entry here, so a new dependency is never left out.

/** Licences any component may have, with the reason each one is accepted (rendered into the documentation). */
export const ALLOWED_LICENSES: Readonly<Record<string, string>> = {
	MIT: 'разрешительная лицензия, прямо названа в ТЗ',
	'MIT-0': 'MIT без условия сохранять уведомление — мягче MIT',
	'Apache-2.0': 'разрешительная лицензия с патентной оговоркой, прямо названа в ТЗ',
	'BSD-2-Clause': 'семейство BSD, прямо названо в ТЗ',
	'BSD-3-Clause': 'семейство BSD, прямо названо в ТЗ',
	ISC: 'функционально равна MIT/BSD-2-Clause',
	'0BSD': 'BSD без условий — мягче BSD-2-Clause',
	Unlicense: 'передача в общественное достояние, условий нет',
	'OFL-1.1': 'SIL Open Font License — стандартная лицензия свободных шрифтов: шрифт можно встраивать и распространять с продуктом, продавать отдельно нельзя',
	'PSF-2.0':
		'лицензия Python Software Foundation — разрешительная, совместима с GPL; так лицензированы сам Python и часть его стандартных пакетов'
};

/** Kinds of components; together with the name they identify an exception. */
export type ComponentKind = 'npm' | 'python' | 'image' | 'system' | 'model' | 'font' | 'tool';

/** A component whose licence is outside ALLOWED_LICENSES, accepted for the stated reason. */
export interface LicenseException {
	kind: ComponentKind;
	name: string;
	/** The licence the exception was granted for: a component that changes it needs a new decision. */
	license: string;
	reason: string;
}

export const LICENSE_EXCEPTIONS: readonly LicenseException[] = [
	{
		kind: 'npm',
		name: '@axe-core/playwright',
		license: 'MPL-2.0',
		reason:
			'проверка доступности в сквозных тестах; в сборку продукта не входит. MPL-2.0 — слабый копилефт на уровне файлов, файлы пакета не изменяются'
	},
	{
		kind: 'python',
		name: 'pillow',
		license: 'MIT-CMU',
		reason:
			'MIT-CMU (HPND) — разрешительная лицензия семейства MIT: использование и распространение с сохранением уведомления, без копилефта'
	},
	{
		kind: 'image',
		name: 'pgvector/pgvector',
		license: 'PostgreSQL',
		reason:
			'PostgreSQL License — разрешительная лицензия семейства BSD/MIT (одобрена OSI), под ней распространяются PostgreSQL и pgvector'
	},
	{
		kind: 'image',
		name: 'eclipse-temurin',
		license: 'GPL-2.0-only WITH Classpath-exception-2.0',
		reason:
			'JDK в песочнице запускает программы кандидатов на Java отдельным процессом; не изменяется и не связывается с кодом продукта. Classpath exception снимает копилефт с запускаемых программ'
	},
	{
		kind: 'image',
		name: 'alpine',
		license: 'MIT AND GPL-2.0-only',
		reason:
			'базовый слой ОС образа туннеля к машине с моделями (musl — MIT, BusyBox — GPL-2.0); используется как операционная система без изменений'
	},
	{
		kind: 'system',
		name: 'fonts-dejavu-core',
		license: 'Bitstream-Vera',
		reason:
			'шрифты DejaVu для отрисовки документов внутри сервиса разбора; лицензия Bitstream Vera разрешает использование и распространение, как OFL'
	},
	{
		kind: 'system',
		name: 'libreoffice-writer-nogui',
		license: 'MPL-2.0',
		reason:
			'конвертация DOC/RTF/ODT в сервисе разбора отдельным процессом без изменений. MPL-2.0 — слабый копилефт на уровне файлов'
	},
	{
		kind: 'system',
		name: 'poppler-utils',
		license: 'GPL-2.0-only OR GPL-3.0-only',
		reason:
			'утилиты PDF в сервисе разбора вызываются отдельным процессом без изменений; с кодом продукта не связываются'
	},
	{
		kind: 'system',
		name: 'g++',
		license: 'GPL-3.0-or-later WITH GCC-exception-3.1',
		reason:
			'компилятор C++ в песочнице для программ кандидатов, вызывается отдельным процессом; GCC Runtime Library Exception снимает копилефт с скомпилированных программ'
	},
	{
		kind: 'system',
		name: 'openssh-server',
		license: 'SSH-OpenSSH',
		reason: 'sshd туннеля к машине с моделями; лицензия OpenSSH — разрешительная, семейства BSD'
	},
	{
		kind: 'tool',
		name: 'pandoc/core',
		license: 'GPL-2.0-or-later',
		reason:
			'сборка этой документации из Markdown в HTML и DOCX; запускается в контейнере, в продукт и его образы не входит'
	}
];

/** Licence of a Python package by its normalised name (PEP 503), from the package metadata on PyPI. */
export const PYTHON_LICENSES: Readonly<Record<string, { license: string; note?: string }>> = {
	anyio: { license: 'MIT' },
	'charset-normalizer': { license: 'MIT' },
	cffi: { license: 'MIT-0' },
	click: { license: 'BSD-3-Clause' },
	cryptography: { license: 'Apache-2.0 OR BSD-3-Clause' },
	defusedxml: { license: 'PSF-2.0' },
	fonttools: { license: 'MIT' },
	h11: { license: 'MIT' },
	idna: { license: 'BSD-3-Clause' },
	lxml: { license: 'BSD-3-Clause' },
	'pdfminer-six': { license: 'MIT' },
	pdfplumber: { license: 'MIT' },
	pillow: { license: 'MIT-CMU' },
	pycparser: { license: 'BSD-3-Clause' },
	pypdf: { license: 'BSD-3-Clause' },
	pypdfium2: {
		license: 'Apache-2.0 OR BSD-3-Clause',
		note: 'в колесо встроена сборка PDFium (BSD-3-Clause) со сторонними библиотеками под их лицензиями — файлы в licenses/ пакета'
	},
	'python-docx': { license: 'MIT' },
	'python-multipart': { license: 'Apache-2.0' },
	reportlab: { license: 'BSD-3-Clause' },
	starlette: { license: 'BSD-3-Clause' },
	'typing-extensions': { license: 'PSF-2.0' },
	uvicorn: { license: 'BSD-3-Clause' }
};

export const PYTHON_LICENSE_SOURCE = 'метаданные пакета (PyPI, поле License-Expression / License)';

/** Licence of a container image by repository; the licence of the software the image ships. */
export const IMAGE_LICENSES: Readonly<Record<string, { license: string; software: string }>> = {
	'pgvector/pgvector': { license: 'PostgreSQL', software: 'PostgreSQL с расширением pgvector' },
	'valkey/valkey': { license: 'BSD-3-Clause', software: 'Valkey — хранилище ключ-значение, протокол Redis' },
	'chrislusf/seaweedfs': { license: 'Apache-2.0', software: 'SeaweedFS — S3-совместимое хранилище файлов' },
	'axllent/mailpit': { license: 'MIT', software: 'Mailpit — SMTP-ловушка писем стенда' },
	nginx: { license: 'BSD-2-Clause', software: 'nginx — шлюз перед сервисами' },
	'ghcr.io/ggml-org/llama.cpp': { license: 'MIT', software: 'llama.cpp server — эмбеддер на CPU' },
	node: { license: 'MIT', software: 'Node.js — среда выполнения приложения' },
	python: { license: 'PSF-2.0', software: 'CPython — среда сервиса разбора и стенда оценки' },
	'ghcr.io/astral-sh/uv': { license: 'MIT OR Apache-2.0', software: 'uv — установка Python-зависимостей по lock-файлу' },
	golang: { license: 'BSD-3-Clause', software: 'Go — сборка go-judge и язык песочницы' },
	'eclipse-temurin': {
		license: 'GPL-2.0-only WITH Classpath-exception-2.0',
		software: 'Eclipse Temurin JDK — язык Java в песочнице'
	},
	alpine: { license: 'MIT AND GPL-2.0-only', software: 'Alpine Linux — базовый слой образа туннеля' },
	'pandoc/core': { license: 'GPL-2.0-or-later', software: 'pandoc — сборка документации' },
	'minlag/mermaid-cli': { license: 'MIT', software: 'mermaid-cli — диаграммы документации' }
};

export const IMAGE_LICENSE_SOURCE = 'файл лицензии в репозитории проекта образа';

/** Operating system packages installed by our Dockerfiles, and modules built from source there. */
export const SYSTEM_LICENSES: Readonly<Record<string, { license: string; purpose: string }>> = {
	'fonts-dejavu-core': { license: 'Bitstream-Vera', purpose: 'шрифты для отрисовки документов' },
	'libreoffice-writer-nogui': { license: 'MPL-2.0', purpose: 'конвертация DOC, RTF, ODT в PDF' },
	'poppler-utils': { license: 'GPL-2.0-only OR GPL-3.0-only', purpose: 'растеризация страниц PDF для OCR' },
	'tesseract-ocr': { license: 'Apache-2.0', purpose: 'распознавание сканов' },
	'tesseract-ocr-eng': { license: 'Apache-2.0', purpose: 'модель OCR, английский' },
	'tesseract-ocr-rus': { license: 'Apache-2.0', purpose: 'модель OCR, русский' },
	tini: { license: 'MIT', purpose: 'init-процесс контейнера' },
	'g++': { license: 'GPL-3.0-or-later WITH GCC-exception-3.1', purpose: 'компилятор C++ песочницы' },
	'openssh-server': { license: 'SSH-OpenSSH', purpose: 'sshd обратного туннеля' },
	'github.com/criyle/go-judge/cmd/go-judge': { license: 'MIT', purpose: 'go-judge — исполнитель песочницы' }
};

export const SYSTEM_LICENSE_SOURCE = 'copyright-файл пакета Debian / Alpine, LICENSE модуля Go';

/**
 * Models and their runtime; each `reference` must occur in docs/models.md, which describes how they are served, so the
 * table cannot name a model the product no longer uses.
 */
export const MODELS: readonly { reference: string; name: string; version: string; license: string; purpose: string }[] =
	[
		{
			reference: 'Qwen/Qwen3-8B-AWQ',
			name: 'Qwen/Qwen3-8B-AWQ',
			version: '4-бит AWQ',
			license: 'Apache-2.0',
			purpose: 'разбор резюме и вакансий в факты с цитатами'
		},
		{
			reference: 'BAAI/bge-reranker-v2-m3',
			name: 'BAAI/bge-reranker-v2-m3',
			version: '—',
			license: 'Apache-2.0',
			purpose: 'переранжирование кандидатов и вакансий'
		},
		{
			reference: 'ggml-org/bge-m3-Q8_0-GGUF@9eba04c',
			name: 'ggml-org/bge-m3-Q8_0-GGUF (BAAI/bge-m3)',
			version: 'ревизия 9eba04c, Q8_0',
			license: 'MIT',
			purpose: 'векторы профилей, вакансий и запросов'
		},
		{
			reference: 'vLLM 0.30.0',
			name: 'vLLM',
			version: '0.30.0',
			license: 'Apache-2.0',
			purpose: 'OpenAI-совместимый сервер моделей на GPU'
		}
	];

export const MODEL_LICENSE_SOURCE = 'карточка модели на Hugging Face, LICENSE репозитория vLLM';

/** Fonts in static/fonts by directory; each directory carries its OFL.txt. */
export const FONTS: Readonly<Record<string, { name: string; license: string; version: string }>> = {
	inter: { name: 'Inter', license: 'OFL-1.1', version: 'вариативный, 100–900' },
	'jetbrains-mono': { name: 'JetBrains Mono', license: 'OFL-1.1', version: '400, 500, 700' }
};

/** Chromium that renders the PDF of the documentation, as installed by Playwright. */
export const CHROMIUM_LICENSE = 'BSD-3-Clause';
