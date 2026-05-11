from pr_reviewer.permissions import is_safe_bash_command


def test_safe_bash_allows_read_only_git_and_search_commands() -> None:
    assert is_safe_bash_command("git diff --find-renames origin/main...HEAD")
    assert is_safe_bash_command("git show --stat HEAD")
    assert is_safe_bash_command("rg -n TODO src")
    assert is_safe_bash_command("sed -n '1,120p' pyproject.toml")


def test_safe_bash_blocks_shell_metacharacters_and_writes() -> None:
    assert not is_safe_bash_command("git diff > /tmp/diff")
    assert not is_safe_bash_command("rg TODO | head")
    assert not is_safe_bash_command("git reset --hard")
    assert not is_safe_bash_command("python script.py")
    assert not is_safe_bash_command("find . -delete")
