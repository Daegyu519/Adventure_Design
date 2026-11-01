"""One diagnostic experiment on a frozen model; no labels or thresholds changed."""
import argparse
from collections import defaultdict
from pathlib import Path

from .data import read_jsonl,write_json
from .model import Predictor
from .weak import signature


def context_ablation(predictor, rows):
    groups=defaultdict(dict)
    known={signature(r):r["label"] for r in rows}
    for r in rows:groups[r["contrast_group_id"]][r["labeling_rule"]]=r
    results=[]
    for row in rows:
        full,_=predictor.predict(row)
        removed={**row,"context":[],"last_them":""}
        no_context,_=predictor.predict(removed,allow_empty=True)
        group=groups[row["contrast_group_id"]]
        other=group["distress-bare-ack"] if row["labeling_rule"]=="factual-confirmation-ack" else group["factual-confirmation-ack"]
        assert row["relation"]==other["relation"]
        swapped={**row,"context":other["context"],"last_them":other["last_them"]}
        swap,_=predictor.predict(swapped)
        results.append({"sample_id":row["sample_id"],"group_id":row["contrast_group_id"],"weak_label":row["label"],
                        "rule":row["labeling_rule"],"actual_context":full,"no_context_relation_retained":no_context,
                        "other_original_context_same_reply":swap,"swapped_weak_label":known.get(signature(swapped)),
                        "actual_minus_no_context":full-no_context,"actual_minus_swapped":full-swap})
    return {"checkpoint_changed":False,"threshold":.5,"n":len(rows),"groups":len(groups),"rows":results,
            "mean_absolute_removal_change":sum(abs(r["actual_minus_no_context"]) for r in results)/len(results),
            "mean_absolute_swap_change":sum(abs(r["actual_minus_swapped"]) for r in results)/len(results),
            "removal_crosses_threshold":sum((r["actual_context"]>=.5)!=(r["no_context_relation_retained"]>=.5) for r in results),
            "swap_crosses_threshold":sum((r["actual_context"]>=.5)!=(r["other_original_context_same_reply"]>=.5) for r in results),
            "conditions":{"removed":"context=[] AND last_them=''; relation retained; serialization markers retained",
                          "swap":"other original context in same weak contrast group; same relation and unchanged draft"},
            "limitations":"Context removal is out-of-distribution. Score changes do not prove correct understanding. Missing swapped label is unknown, not inferred. Original labels remain heuristic, not human truth."}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--checkpoint",type=Path,required=True)
    p.add_argument("--data",type=Path,required=True)
    p.add_argument("--output",type=Path,required=True)
    p.add_argument("--device",choices=["cpu","cuda"],default="cpu")
    args=p.parse_args()
    if args.output.exists():raise ValueError("use a new output file")
    import torch
    torch.set_num_threads(2)
    result=context_ablation(Predictor(args.checkpoint,args.device),read_jsonl(args.data))
    write_json(args.output,result)
    print(__import__('json').dumps({k:v for k,v in result.items() if k!='rows'}))


if __name__=="__main__":main()
