#!/bin/sh
# Stands in for `devin models list --format json` in tests.
cat <<'JSON'
{"families":[
 {"family_label":"Claude Opus 5.5","family_uid":"claude-opus-5-5","slug":"claude-opus-5-5","aliases":["opus"],
  "variants":[
   {"model_uid":"claude-opus-5-5-medium","label":"Claude Opus 5.5 Medium","max_context_tokens":1000000,"max_output_tokens":128000},
   {"model_uid":"claude-opus-5-5-high","label":"Claude Opus 5.5 High","max_context_tokens":1000000,"max_output_tokens":128000}
  ]},
 {"family_label":"Mystery","family_uid":"mystery","slug":"mystery","aliases":[],
  "variants":[{"model_uid":"mystery","label":"Mystery"}]}
]}
JSON
