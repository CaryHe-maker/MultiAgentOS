#!/bin/bash
# Generates the parallel tasks of both tiers (different salts, so no content is shared) and checks
# them: reference solution passes, empty solution fails, and no instruction text repeats.
S=/mnt/c/Users/19810/AppData/Local/Temp/claude/D--19810-Documents-GitHub-MultiAgentOS/8a3a8d5c-c7b6-438b-8b9a-592763d5c6dd/scratchpad/lab
OUT=~/taskset
rm -rf $OUT && mkdir -p $OUT
gen() { # tier family firstSeed n...
  tier=$1; fam=$2; seed=$3; shift 3
  for n in "$@"; do
    node $S/gen-parallel.mjs $fam $seed $n $OUT/$tier/parallel/$fam-s$seed-n$n mao-parallel-v1-$tier > /dev/null || echo "GEN FAIL $fam"
    seed=$((seed + 1))
  done
}
gen dev wide-read 1 6 10 14
gen dev wide-write 1 2 6 10 14
gen dev research-then-implement 1 6 10 14
gen dev small-trap 1 1 1 1
gen dev conflict-trap 1 4 6 8
gen dev failure-recovery 1 6 8 10
gen dev dependency-chain 1 3 5 7
gen final wide-read 101 8 12
gen final wide-write 101 4 8 16
gen final research-then-implement 101 8 12
gen final small-trap 101 1
gen final conflict-trap 101 5 7
gen final failure-recovery 101 12
gen final dependency-chain 101 4
echo "dev: $(ls $OUT/dev/parallel | wc -l)  final: $(ls $OUT/final/parallel | wc -l)"
# duplicates by instruction text and by hidden-test text
cat $OUT/*/parallel/*/instruction.md | wc -l > /dev/null
for f in $OUT/*/parallel/*/instruction.md; do md5sum < $f; done | sort | uniq -d | wc -l | sed 's/^/duplicate instructions: /'
for d in $OUT/*/parallel/*; do
  for m in oracle empty; do
    node $S/taskrun.mjs $m $d $OUT/out | cut -c1-160
  done
done > $OUT/check.jsonl
node -e "
const l=require('fs').readFileSync(process.env.HOME+'/taskset/check.jsonl','utf8').trim().split('\n').map(x=>JSON.parse(x));
const bad=l.filter(r=>(r.mode==='oracle'&&r.reward!==1)||(r.mode==='empty'&&r.reward!==0));
console.log('checked',l.length,'bad',bad.length,bad.map(b=>b.task+':'+b.mode).join(','));
"
