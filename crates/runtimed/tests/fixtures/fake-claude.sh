#!/bin/sh
# Stand-in for the `claude` CLI in the prompt cell integration tests.
#
# Reads the whole user message from stdin, then prints Claude-style stream-json
# lines (see .context/prompt-cells/claude-stream-sample.jsonl): a text block
# start, a few text_delta chunks that form
#
#   Here is code:
#
#   ```{code-cell} python
#   print(42)
#   ```
#   Done.
#
# and a final result line. When the input contains the marker SLOWMODE the
# script pauses after the second chunk (until it is stopped) so a test can
# press Stop mid-stream. IGNOREINT does the same but ignores SIGINT, so only a
# second Stop (SIGKILL) ends it. LONGANSWER streams ~2.5 KiB of paragraphs
# instead, above the 1 KiB inline threshold of the streamed output.
input=$(cat)
delay=0
case "$input" in
  *SLOWMODE*) delay=1 ;;
  *IGNOREINT*) delay=1; trap '' INT ;;
esac

delta() {
  printf '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"%s"}}}\n' "$1"
}

printf '{"type":"system","subtype":"init","session_id":"fake","tools":[]}\n'
printf '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}\n'

case "$input" in
  *LONGANSWER*)
    full=''
    i=1
    while [ "$i" -le 40 ]; do
      line="Line $i of a long answer with enough words to pass the limit.\\n\\n"
      delta "$line"
      full="$full$line"
      i=$((i + 1))
    done
    printf '{"type":"result","subtype":"success","is_error":false,"result":"%s"}\n' "$full"
    exit 0
    ;;
esac
delta 'Here is code:\n\n'
[ "$delay" != 0 ] && sleep 0.3
delta '```{code-cell} python\nprint(42)\n'
[ "$delay" != 0 ] && sleep 30
delta '```\nDone.'
printf '{"type":"result","subtype":"success","is_error":false,"result":"Here is code:\\n\\n```{code-cell} python\\nprint(42)\\n```\\nDone."}\n'
