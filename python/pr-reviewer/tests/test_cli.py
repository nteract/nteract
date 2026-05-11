from pr_reviewer.cli import build_doctor_parser, build_parser, config_from_args


def test_review_parser_accepts_pr_url_without_subcommand() -> None:
    args = build_parser().parse_args(["https://github.com/nteract/desktop/pull/2508"])

    assert args.pr == "https://github.com/nteract/desktop/pull/2508"


def test_doctor_parser_accepts_common_args() -> None:
    args = build_doctor_parser().parse_args(["--model", "model", "--aws-region", "us-west-2"])

    assert args.model == "model"
    assert args.aws_region == "us-west-2"


def test_config_from_args_respects_model_env(monkeypatch) -> None:
    monkeypatch.setenv("PR_REVIEWER_MODEL", "env-model")
    args = build_parser().parse_args(["2508"])

    assert config_from_args(args).model == "env-model"
