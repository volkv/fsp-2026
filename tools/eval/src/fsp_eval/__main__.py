"""Command line: `python -m fsp_eval run|render|manifest|fsp-manifest|matching-manifest …`.

`run` exits with 1 when a metric misses its threshold or a metric with a threshold is not computed: the report and the
recorded row are written first, so the failure is seen with its numbers. The split is always named: a run on the
holdout is a look at it, refused without its entry in the holdout journal (holdout.py).
"""

import argparse
import json
import sys
from pathlib import Path

from fsp_eval.bridge import Bridge
from fsp_eval.dataset import build, load_manifest, new_manifest, write_documents
from fsp_eval.fsp import build_layer, load_layer, new_layer_manifest
from fsp_eval.matching import new_matching_manifest
from fsp_eval.run import RunOptions, execute, summary


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="fsp_eval")
    commands = parser.add_subparsers(dest="command", required=True)

    run = commands.add_parser("run", help="evaluate the product on a split and report the metrics")
    run.add_argument("--repo", type=Path, required=True, help="application checkout with .eval-build/main.js")
    run.add_argument("--out", type=Path, required=True, help="directory for rendered documents and reports")
    run.add_argument("--dataset", default="synthetic-resumes-v2")
    run.add_argument(
        "--split",
        choices=("dev", "holdout"),
        required=True,
        help="dev for everything that changes the product; holdout only with its entry in the holdout journal",
    )
    run.add_argument("--mode", choices=("rules_only", "model"), default="rules_only")
    run.add_argument("--env-file", type=Path, help="environment of the bridge (default: <repo>/.env)")
    run.add_argument("--concurrency", type=int, default=2, help="documents parsed at once")
    run.add_argument(
        "--semantic",
        action="store_true",
        help="rank with semantic similarity: vectors of the catalog from the configured embedder (EMBED_*)",
    )
    run.add_argument(
        "--record",
        metavar="ADMIN_EMAIL",
        help="write the run into eval_runs with the report file owned by this administrator",
    )
    run.add_argument(
        "--fsp-layer",
        default="fsp-achievements-v2",
        help="FSP achievements over the dataset for the ablation («none» — no ablation)",
    )
    run.add_argument(
        "--matching",
        default="synthetic-matching-v1",
        help="vacancies and the truth of the people for matching over the dataset and the FSP layer («none» — none)",
    )

    render = commands.add_parser("render", help="write the documents of a split for a look")
    render.add_argument("--out", type=Path, required=True)
    render.add_argument("--dataset", default="synthetic-resumes-v2")
    render.add_argument("--split", choices=("dev", "holdout"), required=True)

    manifest = commands.add_parser("manifest", help="print the manifest of a new dataset version")
    manifest.add_argument("--id", required=True)
    manifest.add_argument("--seed", type=int, required=True)
    manifest.add_argument("--profiles", type=int, required=True)
    manifest.add_argument("--as-of", required=True, help="reference date, YYYY-MM-DD")
    manifest.add_argument("--holdout-percent", type=int, default=30)

    layer = commands.add_parser("fsp-manifest", help="print the manifest of a new FSP achievements layer")
    layer.add_argument("--id", required=True)
    layer.add_argument("--seed", type=int, required=True)
    layer.add_argument("--dataset", required=True, help="the resume dataset the layer lies over")

    matching = commands.add_parser("matching-manifest", help="print the manifest of a new matching layer")
    matching.add_argument("--id", required=True)
    matching.add_argument("--seed", type=int, required=True)
    matching.add_argument("--dataset", required=True, help="the resume dataset the layer lies over")
    matching.add_argument("--fsp-layer", required=True, help="the FSP layer over the dataset the truth reads")
    matching.add_argument("--vacancies", type=int, required=True, help="vacancies of each split")

    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.command == "run":
        report = execute(
            RunOptions(
                repo=args.repo,
                out=args.out,
                dataset_id=args.dataset,
                split=args.split,
                mode=args.mode,
                fsp_layer=None if args.fsp_layer == "none" else args.fsp_layer,
                matching=None if args.matching == "none" else args.matching,
                concurrency=args.concurrency,
                record_owner=args.record,
                semantic=args.semantic,
            ),
            Bridge(args.repo, args.env_file or args.repo / ".env"),
        )
        print(summary(report))
        if report["threshold_failures"]:
            print(f"{len(report['threshold_failures'])} thresholds failed", file=sys.stderr)
            return 1
    elif args.command == "render":
        dataset = build(load_manifest(args.dataset))
        for file in write_documents(dataset, args.split, args.out):
            print(file.path)
    elif args.command == "matching-manifest":
        dataset = build(load_manifest(args.dataset))
        records = build_layer(load_layer(args.fsp_layer), dataset)
        content = new_matching_manifest(
            args.id, args.seed, dataset, fsp_layer=args.fsp_layer, records=records, vacancies=args.vacancies
        )
        json.dump(content, sys.stdout, ensure_ascii=False, indent="\t")
        print()
    elif args.command == "fsp-manifest":
        content = new_layer_manifest(args.id, args.seed, build(load_manifest(args.dataset)))
        json.dump(content, sys.stdout, ensure_ascii=False, indent="\t")
        print()
    else:
        content = new_manifest(args.id, args.seed, args.profiles, args.as_of, args.holdout_percent)
        json.dump(content, sys.stdout, ensure_ascii=False, indent="\t")
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
