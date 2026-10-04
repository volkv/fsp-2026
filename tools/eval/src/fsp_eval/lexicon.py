"""Hand-written vocabulary of the synthetic resumes.

Labels are independent of the product: the spellings below are the ways people write skills in resumes, collected for
the harness, not read from the taxonomy aliases. Only the label space is shared — skill, role and grade keys of the
taxonomy — because the product answers in it. A spelling the product does not know is a measured miss, not a
generator error.

Both lists describe the same practice, so many spellings are also aliases of the taxonomy: the run measures the share
(`skills.lexicon_overlap`) and reports the spellings the taxonomy does not know as a slice of their own
(`.unfamiliar`), the part of the numbers the taxonomy could not have been fitted to.
"""

from dataclasses import dataclass


def fold_spelling(surface: str) -> str:
    """A spelling compared case-, «ё»- and whitespace-insensitively."""
    return " ".join(surface.casefold().replace("ё", "е").split())


# Skill key → spellings people use in resumes (the first one is the common one).
SKILL_SURFACES: dict[str, tuple[str, ...]] = {
    "python": ("Python", "Python 3", "python3", "Python 3.x", "Питон"),
    "java": ("Java", "Java 17", "Java SE", "Java 8", "Java Core"),
    "go": ("Go", "Golang", "Go 1.21"),
    "php": ("PHP", "PHP 8", "PHP 7.4"),
    "csharp": ("C#", "C Sharp"),
    "javascript": ("JavaScript", "JS", "Javascript (ES6+)", "ES6+", "Vanilla JS"),
    "typescript": ("TypeScript", "TS", "Typescript"),
    "kotlin": ("Kotlin", "Kotlin Coroutines", "Котлин"),
    "swift": ("Swift",),
    "dart": ("Dart",),
    "scala": ("Scala",),
    "sql": ("SQL", "SQL-запросы"),
    "bash": ("Bash", "Shell-скрипты", "Bash scripting", "shell", "sh-скрипты"),
    "html": ("HTML", "HTML5"),
    "css": ("CSS", "CSS3"),
    "sass": ("SCSS", "Sass"),
    "nodejs": ("Node.js", "NodeJS", "Node JS", "Node"),
    "dotnet": (".NET", ".NET Core", ".NET 6", "dotnet"),
    "android": ("Android", "Android SDK"),
    "ios": ("iOS",),
    "linux": ("Linux", "Ubuntu", "Linux (CentOS)", "Debian", "администрирование Linux"),
    "django": ("Django", "Джанго"),
    "fastapi": ("FastAPI", "Fast API"),
    "flask": ("Flask",),
    "celery": ("Celery",),
    "sqlalchemy": ("SQLAlchemy",),
    "spring_boot": ("Spring Boot", "SpringBoot", "Spring Boot 3"),
    "spring": ("Spring", "Spring Framework"),
    "hibernate": ("Hibernate", "Hibernate ORM"),
    "aspnet": ("ASP.NET Core",),
    "efcore": ("Entity Framework", "EF Core"),
    "laravel": ("Laravel",),
    "symfony": ("Symfony",),
    "express": ("Express", "Express.js"),
    "nestjs": ("NestJS", "Nest.js"),
    "grpc": ("gRPC",),
    "rest": ("REST API", "RESTful API", "REST", "REST-API", "RESTful-сервисы"),
    "openapi": ("OpenAPI", "Swagger"),
    "kafka": ("Kafka", "Apache Kafka", "Кафка"),
    "rabbitmq": ("RabbitMQ", "Rabbit MQ", "Rabbit"),
    "microservices": ("микросервисы", "микросервисная архитектура", "Microservices", "Microservice architecture"),
    "react": ("React", "React.js", "ReactJS", "React 18", "Реакт"),
    "nextjs": ("Next.js", "NextJS"),
    "redux": ("Redux", "Redux Toolkit"),
    "vue": ("Vue.js", "Vue 3", "Vue", "VueJS", "Vue 2"),
    "webpack": ("Webpack",),
    "vite": ("Vite",),
    "tailwind": ("Tailwind CSS", "Tailwind"),
    "jetpack_compose": ("Jetpack Compose",),
    "swiftui": ("SwiftUI",),
    "uikit": ("UIKit",),
    "flutter": ("Flutter",),
    "postgresql": ("PostgreSQL", "Postgres", "Постгрес", "PostgreSQL 15", "PgSQL"),
    "mysql": ("MySQL", "MySQL 8"),
    "mssql": ("MS SQL", "MS SQL Server"),
    "mongodb": ("MongoDB", "Mongo", "MongoDB Atlas"),
    "redis": ("Redis",),
    "clickhouse": ("ClickHouse", "Clickhouse", "Кликхаус"),
    "greenplum": ("Greenplum",),
    "pandas": ("pandas", "Pandas"),
    "numpy": ("NumPy", "numpy"),
    "sklearn": ("scikit-learn", "sklearn", "Scikit Learn"),
    "pytorch": ("PyTorch", "Torch"),
    "tensorflow": ("TensorFlow",),
    "catboost": ("CatBoost",),
    "xgboost": ("XGBoost", "LightGBM"),
    "huggingface": ("Hugging Face", "HuggingFace Transformers"),
    "ml": ("машинное обучение", "Machine Learning", "ML", "ML-модели"),
    "dl": ("Deep Learning", "глубокое обучение", "нейронные сети", "нейросети"),
    "nlp": ("NLP", "обработка естественного языка"),
    "llm": ("LLM",),
    "statistics": ("статистика", "математическая статистика", "Statistics", "матстатистика"),
    "spark": ("Apache Spark", "Spark", "PySpark", "Spark SQL"),
    "hadoop": ("Hadoop",),
    "airflow": ("Airflow", "Apache Airflow"),
    "dbt": ("dbt",),
    "etl": ("ETL", "ETL-процессы"),
    "powerbi": ("Power BI", "PowerBI", "Power BI Desktop"),
    "tableau": ("Tableau",),
    "superset": ("Superset", "Apache Superset"),
    "excel": ("Excel", "MS Excel", "Эксель"),
    "jupyter": ("Jupyter", "Jupyter Notebook"),
    "mlops_tools": ("MLflow",),
    "docker": ("Docker", "Docker Compose", "Докер", "Dockerfile"),
    "kubernetes": ("Kubernetes", "k8s", "Кубер", "K8S"),
    "helm": ("Helm",),
    "terraform": ("Terraform",),
    "ansible": ("Ansible",),
    "cicd": ("CI/CD", "CI / CD", "непрерывная интеграция"),
    "gitlab_ci": ("GitLab CI", "GitLab CI/CD", "Gitlab-CI"),
    "github_actions": ("GitHub Actions",),
    "jenkins": ("Jenkins",),
    "git": ("Git",),
    "nginx": ("Nginx",),
    "prometheus": ("Prometheus", "Grafana"),
    "elk": ("ELK", "Kibana"),
    "manual_testing": (
        "ручное тестирование",
        "функциональное тестирование",
        "Manual testing",
        "тест-дизайн",
        "ручное тестирование ПО",
    ),
    "test_automation": (
        "автоматизация тестирования",
        "автотесты",
        "Test automation",
        "автоматизированное тестирование",
        "QA Automation",
    ),
    "selenium": ("Selenium", "Selenium WebDriver"),
    "playwright": ("Playwright",),
    "pytest": ("pytest", "Pytest", "PyTest"),
    "junit": ("JUnit", "JUnit 5"),
    "jest": ("Jest",),
    "postman": ("Postman",),
    "jmeter": ("JMeter", "нагрузочное тестирование", "Load testing", "Apache JMeter"),
    "jira": ("Jira", "JIRA", "Джира", "Atlassian Jira"),
    "bpmn": ("BPMN", "BPMN 2.0", "нотация BPMN"),
    "uml": ("UML", "UML-диаграммы"),
    "requirements": (
        "сбор требований",
        "анализ требований",
        "Requirements gathering",
        "работа с требованиями",
        "выявление требований",
    ),
}

# Out-of-taxonomy tools people list next to skills: the right answer of normalization is «no skill».
DISTRACTORS: tuple[str, ...] = (
    "Trello",
    "Miro",
    "Notion",
    "Slack",
    "Asana",
    "Photoshop",
    "Sentry",
    "Illustrator",
    "WordPress",
    "Tilda",
    "AutoCAD",
)

GRADES: tuple[str, ...] = ("intern", "junior", "middle", "senior", "lead")

# The harness's own rubric of a grade: months of experience in the role a person of the grade has (lead also leads
# people, which the resume says). It defines the synthetic truth; it is not the product's rule set.
GRADE_MONTHS: dict[str, tuple[int, int]] = {
    "intern": (2, 5),
    "junior": (8, 22),
    "middle": (28, 54),
    "senior": (66, 120),
    "lead": (84, 150),
}
GRADE_WEIGHTS: dict[str, int] = {"intern": 8, "junior": 22, "middle": 30, "senior": 25, "lead": 15}

# Seniority words of a title at a grade, Russian and English.
LEVEL_WORDS: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    "intern": (("Стажёр", "Стажер"), ("Intern", "Trainee")),
    "junior": (("Junior", "Младший"), ("Junior",)),
    "middle": (("", "Middle"), ("", "Middle")),
    "senior": (("Senior", "Старший"), ("Senior",)),
    "lead": (("Ведущий", "Lead"), ("Lead", "Principal")),
}


@dataclass(frozen=True)
class Title:
    """A title stem (a level word goes in front of it) and the skills it names: «Python-разработчик» says Python."""

    text: str
    skills: tuple[str, ...] = ()


@dataclass(frozen=True)
class Stack:
    """What a person of the role works with: a pool of skill keys and the titles that fit it."""

    skills: tuple[str, ...]
    titles_ru: tuple[Title, ...]
    titles_en: tuple[Title, ...]


@dataclass(frozen=True)
class RoleSpec:
    key: str
    stacks: tuple[Stack, ...]
    # Achievement lines with one or two slots for skills of the stack; the fixed words name no skill.
    lines_ru: tuple[str, ...]
    lines_en: tuple[str, ...]


def _t(*titles: str | tuple[str, str | tuple[str, ...]]) -> tuple[Title, ...]:
    result = []
    for title in titles:
        if isinstance(title, str):
            result.append(Title(title))
        else:
            text, skills = title
            result.append(Title(text, (skills,) if isinstance(skills, str) else skills))
    return tuple(result)


ROLES: tuple[RoleSpec, ...] = (
    RoleSpec(
        key="backend",
        stacks=(
            Stack(
                (
                    "python",
                    "django",
                    "fastapi",
                    "celery",
                    "sqlalchemy",
                    "postgresql",
                    "redis",
                    "docker",
                    "rabbitmq",
                    "git",
                ),
                _t(("Python-разработчик", "python"), "Backend-разработчик", "Серверный разработчик"),
                _t(("Python Developer", "python"), "Backend Developer", "Backend Engineer"),
            ),
            Stack(
                (
                    "java",
                    "spring_boot",
                    "hibernate",
                    "postgresql",
                    "kafka",
                    "docker",
                    "kubernetes",
                    "rest",
                    "git",
                    "sql",
                ),
                _t(("Java-разработчик", "java"), "Backend-разработчик"),
                _t(("Java Developer", "java"), "Backend Engineer"),
            ),
            Stack(
                ("go", "grpc", "postgresql", "redis", "kafka", "docker", "kubernetes", "microservices", "git"),
                _t(("Golang-разработчик", "go"), "Backend-разработчик"),
                _t(("Golang Developer", "go"), "Backend Engineer"),
            ),
            Stack(
                ("php", "laravel", "symfony", "mysql", "redis", "docker", "nginx", "rest", "git"),
                _t(("PHP-программист", "php"), "Backend-разработчик"),
                _t(("PHP Developer", "php"), "Backend Developer"),
            ),
            Stack(
                ("csharp", "dotnet", "aspnet", "efcore", "mssql", "docker", "rabbitmq", "rest", "git"),
                _t((".NET-разработчик", "dotnet"), "Backend-разработчик"),
                _t((".NET Developer", "dotnet"), "Backend Engineer"),
            ),
        ),
        lines_ru=(
            "Разработка сервисов на {0} и {1}",
            "Проектирование схемы данных и оптимизация запросов к {0}",
            "Интеграция сервисов через {0}",
            "Покрытие кода тестами, настройка {0}",
            "Перенос монолита на {0} и {1}",
            "Разработка фоновых задач с использованием {0}",
        ),
        lines_en=(
            "Built services with {0} and {1}",
            "Designed the data schema and tuned queries in {0}",
            "Integrated services via {0}",
            "Covered code with tests, set up {0}",
            "Moved the monolith to {0} and {1}",
            "Implemented background jobs with {0}",
        ),
    ),
    RoleSpec(
        key="frontend",
        stacks=(
            Stack(
                ("javascript", "typescript", "react", "redux", "nextjs", "html", "css", "webpack", "jest", "git"),
                _t("Frontend-разработчик", "Фронтенд-разработчик", ("React-разработчик", "react")),
                _t("Frontend Developer", "Front-end Engineer", ("React Developer", "react")),
            ),
            Stack(
                ("javascript", "typescript", "vue", "vite", "html", "sass", "tailwind", "jest", "git"),
                _t("Frontend-разработчик", "Фронтенд-разработчик"),
                _t("Frontend Developer", "Front-end Engineer"),
            ),
        ),
        lines_ru=(
            "Разработка интерфейсов на {0} и {1}",
            "Адаптивные страницы личного кабинета, {0}",
            "Настройка сборки на {0}",
            "Покрытие компонентов тестами на {0}",
            "Перевод проекта на {0}",
        ),
        lines_en=(
            "Built user interfaces with {0} and {1}",
            "Responsive account pages, {0}",
            "Set up the build with {0}",
            "Covered components with tests in {0}",
            "Migrated the project to {0}",
        ),
    ),
    RoleSpec(
        key="fullstack",
        stacks=(
            Stack(
                ("typescript", "javascript", "react", "nodejs", "nestjs", "postgresql", "docker", "git", "sql"),
                _t("Fullstack-разработчик", "Фулстек-разработчик"),
                _t("Full Stack Developer", "Fullstack Engineer"),
            ),
            Stack(
                ("javascript", "vue", "nodejs", "express", "mongodb", "docker", "git", "rest"),
                _t("Fullstack-разработчик", "Фулстек-разработчик"),
                _t(
                    "Full Stack Developer",
                ),
            ),
        ),
        lines_ru=(
            "Разработка клиентской части на {0} и серверной на {1}",
            "Проектирование обмена данными на {0}",
            "Работа с базой данных {0}",
            "Развёртывание приложений в {0}",
        ),
        lines_en=(
            "Built the client in {0} and the server in {1}",
            "Designed data exchange with {0}",
            "Worked with the {0} database",
            "Deployed applications with {0}",
        ),
    ),
    RoleSpec(
        key="mobile",
        stacks=(
            Stack(
                ("kotlin", "android", "jetpack_compose", "rest", "git"),
                _t(("Android-разработчик", "android"), "Мобильный разработчик"),
                _t(("Android Developer", "android"), "Mobile Developer"),
            ),
            Stack(
                ("swift", "ios", "swiftui", "uikit", "rest", "git"),
                _t(("iOS-разработчик", "ios"), "Мобильный разработчик"),
                _t(("iOS Developer", "ios"), "Mobile Developer"),
            ),
            Stack(
                ("dart", "flutter", "android", "ios", "git"),
                _t(("Flutter-разработчик", "flutter"), "Мобильный разработчик"),
                _t(("Flutter Developer", "flutter"), "Mobile Developer"),
            ),
        ),
        lines_ru=(
            "Разработка мобильного приложения на {0}",
            "Перевод экранов на {0}",
            "Интеграция с бэкендом через {0}",
            "Публикация сборок, работа с {0}",
        ),
        lines_en=(
            "Developed the mobile app in {0}",
            "Moved screens to {0}",
            "Integrated with the backend via {0}",
            "Shipped builds, worked with {0}",
        ),
    ),
    RoleSpec(
        key="devops",
        stacks=(
            Stack(
                (
                    "docker",
                    "kubernetes",
                    "helm",
                    "gitlab_ci",
                    "terraform",
                    "ansible",
                    "linux",
                    "prometheus",
                    "bash",
                    "nginx",
                ),
                _t("DevOps-инженер", "Инженер DevOps"),
                _t(
                    "DevOps Engineer",
                ),
            ),
            Stack(
                ("docker", "kubernetes", "cicd", "github_actions", "jenkins", "linux", "elk", "python", "terraform"),
                _t(
                    "DevOps-инженер",
                ),
                _t(
                    "DevOps Engineer",
                ),
            ),
        ),
        lines_ru=(
            "Построение конвейеров поставки на {0}",
            "Перевод сервисов в {0}",
            "Настройка мониторинга на {0}",
            "Автоматизация инфраструктуры с {0} и {1}",
            "Администрирование серверов {0}",
        ),
        lines_en=(
            "Built delivery pipelines on {0}",
            "Moved services to {0}",
            "Set up monitoring with {0}",
            "Automated infrastructure with {0} and {1}",
            "Administered {0} servers",
        ),
    ),
    RoleSpec(
        key="qa_manual",
        stacks=(
            Stack(
                ("manual_testing", "sql", "postman", "jira", "rest"),
                _t("Тестировщик", "QA-инженер", "Инженер по тестированию"),
                _t("QA Engineer", "Software Tester"),
            ),
        ),
        lines_ru=(
            "Проверка веб-приложения перед релизами, {0}",
            "Проверка API в {0}",
            "Заведение дефектов в {0}",
            "Сверка данных запросами {0}",
        ),
        lines_en=(
            "Checked the web app before releases, {0}",
            "Checked APIs in {0}",
            "Filed defects in {0}",
            "Verified data with {0} queries",
        ),
    ),
    RoleSpec(
        key="qa_automation",
        stacks=(
            Stack(
                ("test_automation", "python", "pytest", "selenium", "playwright", "postman", "cicd", "git"),
                _t(("Инженер по автоматизации тестирования", "test_automation"), "AQA-инженер"),
                _t(("QA Automation Engineer", "test_automation"), "SDET"),
            ),
            Stack(
                ("test_automation", "java", "junit", "selenium", "jmeter", "cicd", "git"),
                _t(("Инженер по автоматизации тестирования", "test_automation"), "AQA-инженер"),
                _t(
                    ("QA Automation Engineer", "test_automation"),
                ),
            ),
        ),
        lines_ru=(
            "Разработка тестов на {0} и {1}",
            "Встраивание тестов в {0}",
            "Проверка производительности, {0}",
            "UI-тесты на {0}",
        ),
        lines_en=(
            "Wrote tests with {0} and {1}",
            "Integrated tests into {0}",
            "Performance checks, {0}",
            "UI tests with {0}",
        ),
    ),
    RoleSpec(
        key="data_analyst",
        stacks=(
            Stack(
                ("sql", "python", "pandas", "excel", "statistics", "powerbi", "tableau", "superset", "clickhouse"),
                _t("Аналитик данных", "BI-аналитик"),
                _t("Data Analyst", "BI Analyst"),
            ),
        ),
        lines_ru=(
            "Построение отчётов в {0}",
            "Подготовка выгрузок на {0} и {1}",
            "Расчёт метрик продукта, {0}",
            "Автоматизация отчётности на {0}",
        ),
        lines_en=(
            "Built reports in {0}",
            "Prepared data extracts with {0} and {1}",
            "Computed product metrics, {0}",
            "Automated reporting with {0}",
        ),
    ),
    RoleSpec(
        key="data_engineer",
        stacks=(
            Stack(
                (
                    "sql",
                    "python",
                    "spark",
                    "airflow",
                    "kafka",
                    "clickhouse",
                    "hadoop",
                    "etl",
                    "dbt",
                    "greenplum",
                    "scala",
                ),
                _t("Дата-инженер", "Инженер данных"),
                _t(
                    "Data Engineer",
                ),
            ),
        ),
        lines_ru=(
            "Разработка сервисов обработки на {0} и {1}",
            "Оркестрация загрузок в {0}",
            "Построение витрин в {0}",
            "Обработка потока событий из {0}",
        ),
        lines_en=(
            "Built processing services with {0} and {1}",
            "Orchestrated loads in {0}",
            "Built data marts in {0}",
            "Processed event streams from {0}",
        ),
    ),
    RoleSpec(
        key="data_scientist",
        stacks=(
            Stack(
                ("python", "ml", "pandas", "numpy", "sklearn", "statistics", "catboost", "xgboost", "sql", "pytorch"),
                _t("Data Scientist", "Дата-сайентист", "Специалист по анализу данных"),
                _t(
                    "Data Scientist",
                ),
            ),
        ),
        lines_ru=(
            "Построение моделей оттока на {0} и {1}",
            "Подготовка признаков в {0}",
            "Анализ экспериментов, {0}",
            "Прогнозирование спроса с {0}",
        ),
        lines_en=(
            "Built churn models with {0} and {1}",
            "Engineered features in {0}",
            "Analysed experiments, {0}",
            "Forecast demand with {0}",
        ),
    ),
    RoleSpec(
        key="ml_engineer",
        stacks=(
            Stack(
                ("python", "ml", "dl", "pytorch", "tensorflow", "huggingface", "llm", "nlp", "mlops_tools", "docker"),
                _t(("ML-инженер", "ml"), ("Инженер машинного обучения", "ml")),
                _t(("ML Engineer", "ml"), ("Machine Learning Engineer", "ml")),
            ),
        ),
        lines_ru=(
            "Обучение и вывод в прод моделей на {0}",
            "Дообучение моделей, {0} и {1}",
            "Трекинг экспериментов в {0}",
            "Сервинг моделей в {0}",
        ),
        lines_en=(
            "Trained and shipped models in {0}",
            "Fine-tuned models, {0} and {1}",
            "Tracked experiments in {0}",
            "Served models with {0}",
        ),
    ),
    RoleSpec(
        key="systems_analyst",
        stacks=(
            Stack(
                ("requirements", "sql", "uml", "bpmn", "rest", "openapi", "kafka", "jira"),
                _t(
                    "Системный аналитик",
                ),
                _t("Systems Analyst", "System Analyst"),
            ),
        ),
        lines_ru=(
            "Описание интеграций, спецификации {0}",
            "Моделирование процессов в нотации {0}",
            "Постановка задач в {0}",
            "Анализ данных запросами {0}",
        ),
        lines_en=(
            "Described integrations, {0} specifications",
            "Modelled processes in {0}",
            "Wrote tasks in {0}",
            "Analysed data with {0} queries",
        ),
    ),
)

GENERIC_LINES_RU: tuple[str, ...] = (
    "Участие в код-ревью и планировании задач",
    "Взаимодействие с заказчиком и командой продукта",
    "Сокращение времени отклика сервиса на 30%",
    "Подготовка документации для команды",
)
GENERIC_LINES_EN: tuple[str, ...] = (
    "Took part in code reviews and task planning",
    "Worked with the customer and the product team",
    "Cut service response time by 30%",
    "Wrote documentation for the team",
)

# Responsibility lines by the harness's own labels (mentoring, leading a team, designing architecture).
MARKER_LINES: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    "mentoring": (
        ("Менторил двух младших разработчиков", "Наставничество для стажёров", "Обучал новых сотрудников команды"),
        ("Mentored two junior engineers", "Mentoring of interns"),
    ),
    "team_lead": (
        (
            "Руководил командой из {n} разработчиков",
            "Руководство группой из {n} человек",
            "Управлял командой из {n} инженеров",
        ),
        ("Led a team of {n} engineers", "Managed a team of {n} developers"),
    ),
    "architecture": (
        ("Спроектировал архитектуру платежного сервиса", "Проектирование архитектуры новой платформы"),
        ("Designed the architecture of the payment service", "Architected the new platform"),
    ),
}

NEGATED_LINES_RU: tuple[str, ...] = ("Планирую изучить {0}", "Нет коммерческого опыта с {0}", "Хочу освоить {0}")
NEGATED_LINES_EN: tuple[str, ...] = ("Planning to learn {0}", "No commercial experience with {0}")

ABOUT_RU: tuple[str, ...] = (
    "Ответственный, люблю разбираться в сложных задачах.",
    "Открыт к новым проектам, ценю понятные процессы.",
    "Интересуюсь качеством кода и понятной документацией.",
)
ABOUT_EN: tuple[str, ...] = (
    "Responsible, enjoy digging into hard problems.",
    "Open to new projects, value clear processes.",
)

# Invented names: combinations drawn at random, no real person is described.
FIRST_NAMES: tuple[str, ...] = (
    "Алексей",
    "Мария",
    "Дмитрий",
    "Анна",
    "Илья",
    "Екатерина",
    "Олег",
    "Софья",
    "Роман",
    "Вера",
)
LAST_NAMES_M: tuple[str, ...] = ("Громов", "Лесной", "Вершинин", "Озёров", "Туманов", "Беляев", "Ручьёв", "Полевой")
FEMALE_NAMES: frozenset[str] = frozenset({"Мария", "Анна", "Екатерина", "Софья", "Вера"})
CITIES: tuple[str, ...] = ("Москва", "Казань", "Новосибирск", "Екатеринбург", "Самара", "Томск")

# Invented organizations: (Russian form, English form, the name inside). The name is what a reader must recover.
ORGANIZATIONS: tuple[tuple[str, str], ...] = (
    ("ООО «Северный Код»", "Severny Kod LLC"),
    ("АО «Цифровые Линии»", "Tsifrovye Linii JSC"),
    ("ООО «Облачный Мост»", "Oblachny Most LLC"),
    ("ООО «Тихая Гавань Софт»", "Tikhaya Gavan Soft LLC"),
    ("«Ясная Логика»", "Yasnaya Logika"),
    ("ООО «Кварцевые Системы»", "Kvartsevye Sistemy LLC"),
    ("АО «Лемма Технологии»", "Lemma Tekhnologii JSC"),
    ("ООО «Звёздный Пиксель»", "Zvyozdny Piksel LLC"),
    ("Студия «Бумажный Журавль»", "Bumazhny Zhuravl Studio"),
    ("ООО «Граница Данных»", "Granitsa Dannykh LLC"),
)

INSTITUTIONS: tuple[tuple[str, str], ...] = (
    ("Северо-Восточный институт информатики", "North-Eastern Institute of Informatics"),
    ("Приволжский университет прикладной математики", "Volga University of Applied Mathematics"),
    ("Балтийский колледж цифровых технологий", "Baltic College of Digital Technologies"),
    ("Уральская высшая школа программирования", "Ural Higher School of Programming"),
)
DEGREES_RU: tuple[str, ...] = ("Бакалавр, прикладная информатика", "Магистр, программная инженерия", "Специалист, ИВТ")
DEGREES_EN: tuple[str, ...] = ("Bachelor, Applied Informatics", "Master, Software Engineering")

# Language codes and how templates name them.
LANGUAGE_NAMES: dict[str, tuple[str, str]] = {"en": ("Английский", "English"), "de": ("Немецкий", "German")}
LANGUAGE_LEVELS: tuple[str, ...] = ("A2", "B1", "B2", "C1")
LEVEL_WORDS_HH: dict[str, str] = {
    "A2": "Элементарный",
    "B1": "Средний",
    "B2": "Средне-продвинутый",
    "C1": "Продвинутый",
}

# Skills a person without experience lists (a student looking for a first job).
STARTER_SKILLS: tuple[str, ...] = ("git", "jira")
