"""What a reader sees in the synthetic fixtures: facts that must come out verbatim, grouped by where they belong."""

from __future__ import annotations

HH_EXPORT_FACTS = {
    "header": ["Примеров Алексей Игоревич", "+7 (900) 000-00-01", "alexey.primerov@example.com", "Проживает: Москва"],
    "job1": ["Март 2021 — настоящее время", "ООО «Пример Технолоджиз»"],
    "job2": ["Июнь 2019 — Февраль 2021", "АО «Вектор-Облако Тест»"],
    "job3": ["Сентябрь 2018 — Май 2019", "ИП Выдумкин Н. Н.", "Младший разработчик"],
    "education": ["Московский учебный университет примеров", "Прикладная математика и информатика"],
    "skills": ["FastAPI", "Django", "PostgreSQL", "RabbitMQ", "Kubernetes", "SQLAlchemy", "Английский — B2"],
}
# Dates sit in a narrow left column on the same line as the company on the right: they must stay adjacent.
HH_EXPORT_DATE_COMPANY = [
    ("Март 2021 — настоящее время", "ООО «Пример Технолоджиз»"),
    ("Июнь 2019 — Февраль 2021", "АО «Вектор-Облако Тест»"),
    ("Сентябрь 2018 — Май 2019", "ИП Выдумкин Н. Н."),
]

TABLE_DOCX_FACTS = {
    "header": ["Образцова Марина Сергеевна", "Frontend-разработчик (TypeScript, React)"],
    "contacts": ["+7 (900) 000-00-02", "marina.obraztsova@example.com"],
    "job1": ["01.2022 – н. в.", "ООО «Интерфейс Пример»", "Старший frontend-разработчик"],
    "job2": ["04.2020 – 12.2021", "ЗАО «Тестовые Решения»"],
    "job3": ["07.2018 – 03.2020", "Студия «Макет и Код»", "Верстальщик"],
    "skills": ["Redux Toolkit", "Next.js", "Playwright", "CSS Modules", "Figma"],
    "education": ["Уральский учебный институт примеров"],
    "about": ["Люблю TypeScript 🚀 и доступные интерфейсы", "Рекомендации предоставлю по запросу."],
}

TWO_COLUMN_SIDEBAR = [
    "+7 (900) 000-00-03",
    "petr.vymyslov@example.com",
    "Новосибирск",
    "Terraform",
    "Ansible",
    "Prometheus",
    "GitLab CI",
    "Ceph",
    "Английский — C1",
]
TWO_COLUMN_MAIN = [
    "Вымыслов Пётр",
    "DevOps-инженер / SRE",
    "Ведущий SRE-инженер",
    "ООО «Облачный Пример»",
    "10/2022 – по наст. время",
    "АО «Сибирский Тестовый Банк»",
    "03/2019 – 09/2022",
    "ООО «Сеть Выдумки»",
    "Новосибирский учебный технический университет",
    "Информатика и вычислительная техника, 2017",
]

RTF_FACTS = {
    "header": ["Синтетова Ольга Викторовна", "+7 (900) 000-00-04", "olga.sintetova@example.com"],
    "job1": ["Август 2022 — настоящее время", "ООО «Данные и Примеры»", "Старший аналитик данных"],
    "job2": ["Сентябрь 2020 — Июль 2022", "АО «Учебная Розница»"],
    "education": ["Приволжский учебный университет статистики"],
    "skills": ["ClickHouse", "pandas", "Apache Airflow", "Tableau", "Статистический анализ", "A/B-тестирование"],
}

# OCR of the scan. "Java-разработчик" is not listed: Tesseract misreads Latin and Cyrillic joined by a hyphen.
SCAN_FACTS = {
    "header": ["Макетов Денис Андреевич", "+7 (900) 000-00-05", "denis.maketov@example.com", "Город: Самара"],
    "job1": ["ООО «Логистика Пример»", "Апрель 2021 — настоящее время"],
    "job2": ["ООО «Софт Выдумка»", "Июль 2018 — Март 2021"],
    "skills": ["Spring Boot", "Hibernate", "Maven", "Kafka", "JUnit"],
}
