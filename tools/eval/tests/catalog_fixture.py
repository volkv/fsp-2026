"""What the bridge's `info` answers of the catalog, in the shape the harness reads: defining blocks with their skills,
practice languages with the skill each confirms. A small catalog of its own: the tests do not depend on the
product's."""

from fsp_eval.matching import CATALOG_GRADES

BLOCKS = {
    "backend": [("be.db", ["sql", "databases"]), ("be.api", ["rest"])],
    "frontend": [("fe.js", ["javascript", "typescript"]), ("fe.dom", ["html", "css"])],
    "qa": [("qa.design", ["manual_testing"]), ("qa.strategy", [])],
    "data_ml": [("ds.stats", ["statistics"]), ("ds.metrics", ["ml"])],
}
LANGUAGES = {
    "backend": [("python3", "python"), ("go", "go"), ("java21", "java")],
    "frontend": [("javascript", "javascript"), ("typescript", "typescript")],
    "qa": [("python3", "python")],
    "data_ml": [("python3", "python")],
}


def catalog_info() -> dict:
    return {
        "versions": {"catalog": "test"},
        "specializations": [
            {"key": key, "open": True, "practice_languages": [{"key": k, "skill": s} for k, s in langs]}
            for key, langs in LANGUAGES.items()
        ],
        "categories": [
            {
                "specialization": specialization,
                "grade": grade,
                "open": True,
                "defining": [{"block": b, "items": 4, "skill_keys": skills} for b, skills in defining],
            }
            for specialization, defining in BLOCKS.items()
            for grade in CATALOG_GRADES
        ],
    }
