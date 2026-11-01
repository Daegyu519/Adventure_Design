"""Read-only P-14 failure audit. Export scores/aggregates, never conversation text.

All lexical situation tags are screening cues, not human situation/tone labels.
No threshold or training data is selected from the frozen contrast set.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
from collections import Counter, defaultdict
from pathlib import Path

from .cold_data import ACK, audit, neutral
from .data import candidates, documents, read_jsonl, write_json, write_jsonl
from .model import Predictor, encode, metrics
from .weak import DISTRESS, eligible, topics

TAGS = {
    "factual_confirmation": r"맞지|맞나요|맞죠|해도 되|보내.*돼|[0-9].*(시|분)|일정|시간.*[?？]",
    "emotion": DISTRESS.pattern,
    "request": r"부탁|도와|도움|해\s*줄|해\s*주실|해\s*줘|할\s*수\s*있|해도\s*되",
    "refusal": r"못\s*해|못\s*가|어려울\s*것|힘들\s*것|안\s*돼|안\s*되|거절",
    "apology": r"미안|죄송|사과|잘못했",
    "celebration": r"축하|합격|승진|성공했|기쁜|기뻐|행복|신나",
    "daily_sharing": r"밥|점심|저녁|산책|영화|드라마|날씨|주말|퇴근|운동",
}
DISMISSAL_CUE = re.compile(r"알아서\s*해|어쩌라고|관심\s*없|상관\s*없|듣기\s*싫|귀찮|네\s*사정|니\s*사정|징징")


def tags(row):
    result = [name for name, pattern in TAGS.items() if re.search(pattern, row["last_them"])]
    if not row.get("relation", "").strip() or row.get("relation") == "미상" or not row["last_them"].strip():
        result.append("insufficient_metadata")
    return result or ["unclassified"]


def distribution(values):
    import numpy as np
    return {"n": len(values), "mean": float(np.mean(values)),
            **dict(zip(("min", "p05", "p25", "median", "p75", "p95", "max"),
                       map(float, np.quantile(values, [0, .05, .25, .5, .75, .95, 1]))))}


def score_summary(labels, scores, include_pr=True):
    import numpy as np
    result = metrics(labels, scores)
    neg = [s for y, s in zip(labels, scores) if y == 0]
    pos = [s for y, s in zip(labels, scores) if y == 1]
    result["class_score_distribution"] = {"0": distribution(neg), "1": distribution(pos)}
    result["roc_auc_pairwise"] = sum((p > n) + .5 * (p == n) for p in pos for n in neg) / (len(pos) * len(neg))
    result["overlap"] = {
        "positive_fraction_in_negative_range": sum(min(neg) <= p <= max(neg) for p in pos) / len(pos),
        "negative_fraction_in_positive_range": sum(min(pos) <= n <= max(pos) for n in neg) / len(neg),
        "negative_max_above_positive_min": max(neg) >= min(pos),
    }
    matrix = result["confusion_matrix"]
    class_metrics = {}
    for k in (0, 1):
        tp = matrix[k][k]; fp = matrix[1-k][k]; fn = matrix[k][1-k]
        precision = tp/(tp+fp) if tp+fp else 0.
        recall = tp/(tp+fn) if tp+fn else 0.
        class_metrics[str(k)] = {"precision": precision, "recall": recall,
                                 "f1": 2*precision*recall/(precision+recall) if precision+recall else 0.}
    result["class_metrics"] = class_metrics
    if include_pr:
        result["diagnostic_pr_grid"] = [{"threshold": t/100,
            **{k: v for k, v in metrics(labels, scores, t/100).items() if k in {"precision", "recall", "f1", "predicted_labels"}}}
            for t in range(5, 100, 5)]
        result["threshold_policy"] = "diagnostic grid only; production threshold stays 0.5; no selected threshold"
    return result


def contains(sequence, part):
    return any(sequence[i:i+len(part)] == part for i in range(len(sequence)-len(part)+1))


def encoding_audit(predictor, rows):
    import torch
    from transformers import DataCollatorWithPadding
    tok, maximum = predictor.tokenizer, predictor.metadata["max_length"]
    input_format = predictor.metadata.get("input_format","legacy-v1")
    special_count = 3 if input_format == "context-pair-v2" else tok.num_special_tokens_to_add(pair=True)
    lengths, context_lengths, reply_lengths = [], [], []
    result = Counter()
    for row in rows:
        enc = encode(tok, row, maximum,input_format=input_format)
        feature_only = {k: row[k] for k in ("relation", "context", "last_them", "draft")}
        assert enc == encode(tok, feature_only, maximum,input_format=input_format)
        assert enc["attention_mask"] == [1] * len(enc["input_ids"])
        assert len(enc["input_ids"]) <= maximum
        lengths.append(len(enc["input_ids"]))
        first = [i for i,t in zip(enc["input_ids"],enc["token_type_ids"]) if t == 0]
        # Byte-level BPE changes the first token after a space: compare the
        # serialized suffix, not standalone last_them token IDs.
        last = tok.encode("\n상대 최근 발화: "+row["last_them"], add_special_tokens=False)
        draft = tok.encode("내 답장: " + row["draft"], add_special_tokens=False)
        context = "\n".join(f"{t['role']}: {t['text']}" for t in row["context"][-8:])
        raw_history = tok.encode(context + "\n상대 최근 발화: " + row["last_them"], add_special_tokens=False)
        context_lengths.append(len(raw_history)); reply_lengths.append(len(draft))
        result["last_them_not_fully_preserved"] += not contains(first, last)
        result["reply_truncated"] += len(draft) > (maximum-special_count)//2
        result["recent_turn_duplicates_last_them"] += bool(row["context"] and row["context"][-1]["role"] == "them"
                                                        and row["context"][-1]["text"] == row["last_them"])
        available = maximum-special_count
        effective_relation = min(len(tok.encode("관계: "+row["relation"],add_special_tokens=False)),24,available//4)
        history_budget = available-effective_relation-min(len(draft),available//2)
        result["history_truncated"] += len(raw_history) > history_budget
        result["starts_with_cls"] += enc["input_ids"][0] == tok.cls_token_id
        result["has_pair_separators"] += enc["input_ids"].count(tok.sep_token_id) >= 2
    example = [{**encode(tok,r,maximum,input_format=input_format), "labels": r["label"]} for r in rows[:8]]
    batch = DataCollatorWithPadding(tok)(example)
    for i, row in enumerate(example):
        assert int(batch["attention_mask"][i].sum()) == len(row["input_ids"])
        assert int(batch["labels"][i]) == row["labels"]
    assert torch.all(batch["input_ids"][batch["attention_mask"] == 0] == tok.pad_token_id)
    batch = {k:v.to(predictor.device) for k,v in batch.items()}
    with torch.inference_mode():
        output = predictor.model(**batch)
        explicit_loss = torch.nn.functional.cross_entropy(output.logits, batch["labels"])
    assert abs(float(output.loss)-float(explicit_loss)) < 1e-6
    result.update({"rows":len(rows),"attention_mask_checks_passed":len(example),"shared_encode_checks_passed":len(rows)})
    return {**dict(result),"input_tokens":distribution(lengths),"raw_history_tokens":distribution(context_lengths),
            "raw_reply_tokens":distribution(reply_lengths),"loss_matches_integer_label_cross_entropy":True,
            "saved_id2label":predictor.model.config.id2label,"tokenizer_class":type(tok).__name__,
            "tokenizer_special_count_pair":tok.num_special_tokens_to_add(pair=True),
            "epoch_score_history":"unavailable: original training stored only loss, final checkpoint and final evaluation"}


def summarize_rows(rows):
    counts, replies, relations, expressions, rules, theme = Counter(),Counter(),Counter(),Counter(),Counter(),Counter()
    for r in rows:
        counts.update(tags(r)); replies.update(tags({**r,"last_them":r["draft"]})); relations[r.get("relation", "")]+=1
        rules[r.get("labeling_rule", "unknown")]+=1
        match=ACK.match(r.get("original_reply",r["draft"]).strip())
        if match:expressions[match.group(1)]+=1
        theme.update(topics(r["last_them"]))
    return {"n":len(rows),"last_them_situation_cues_multilabel":dict(counts),"draft_cues_multilabel":dict(replies),"relations":dict(relations),
            "source_ack_prefix_counts":dict(expressions),"labeling_rules":dict(rules),"topic_cues":dict(theme),
            "tag_interpretation":"lexical screening counts, not human labels; categories overlap"}


def source_audit(root, queue_dir=None):
    if queue_dir:
        queue_dir.mkdir(parents=True,exist_ok=False)
    result = {"scope":"all original listener candidates; no new labels generated","splits":{}}
    for split in ("train","validation"):
        stats, cues, reply_cues, selectable, prefixes, relations, dismissals = Counter(),Counter(),Counter(),Counter(),Counter(),Counter(),Counter()
        pending = []
        for obj,source in documents(root/split,stats):
            for r in candidates(obj,source,split):
                stats["listener_candidates"]+=1
                cues.update(tags(r));reply_cues.update(tags({**r,"last_them":r["original_reply"]}));relations[r["relation"]]+=1
                if DISMISSAL_CUE.search(r["original_reply"]):
                    dismissals["candidate_count"]+=1
                    if queue_dir:
                        pending.append({**r,"draft":r["original_reply"],"label":"uncertain",
                            "label_source":"unreviewed_lexical_candidate","review_status":"pending",
                            "is_training_data":False,"screening_cues":tags(r)})
                match=ACK.match(r["original_reply"].strip())
                if match and r["relation"] and r["relation"]!="미상":
                    kind = "factual" if neutral(r) else "distress" if len(r["last_them"])>=20 and DISTRESS.search(r["last_them"]) and eligible(r) else None
                    if kind:
                        selectable[kind]+=1;prefixes[(kind,match.group(1))]+=1
        result["splits"][split]={"source_counts":dict(stats),"last_them_situation_cues_multilabel":dict(cues),"original_reply_cues_multilabel":dict(reply_cues),
            "relations":dict(relations),"existing_rule_eligible":dict(selectable),
            "eligible_prefix_counts":{"|".join(k):v for k,v in prefixes.items()},
            "dismissal_lexical_candidates":dict(dismissals),
            "dismissal_caveat":"may be quotes or negations; NOT valid high-risk training labels"}
        if queue_dir:
            write_jsonl(queue_dir/(split+".unlabeled.jsonl"),pending)
            result["splits"][split]["unlabeled_queue_rows"]=len(pending)
    return result


def run(args):
    import torch
    torch.set_num_threads(2)
    args.output.mkdir(parents=True,exist_ok=False)
    predictor=Predictor(args.checkpoint,args.device)
    train=read_jsonl(args.data/"train.jsonl");val=read_jsonl(args.data/"validation.jsonl")
    report={"checkpoint":str(args.checkpoint),"device":args.device,"threshold":.5,"split_leakage_audit":audit(train,val),"splits":{}}
    for name,rows in (("train",train),("validation",val)):
        scores=[]
        for i in range(0,len(rows),8):scores.extend(predictor.predict_batch(rows[i:i+8]))
        result=score_summary([r["label"] for r in rows],scores)
        result["encoding"]=encoding_audit(predictor,rows)
        result["data_profile"]=summarize_rows(rows)
        safe=[];groups=defaultdict(dict)
        for r,s in zip(rows,scores):
            safe.append({"sample_id":r["sample_id"],"contrast_group_id":r["contrast_group_id"],
                         "label":r["label"],"cold_score":s,"predicted_label":int(s>=.5),"rule":r["labeling_rule"]})
            groups[r["contrast_group_id"]][r["labeling_rule"]]=s
        result["group_score_deltas"]=[{"group_id":g,
            "distress_ack_minus_factual_ack":v["distress-bare-ack"]-v["factual-confirmation-ack"],
            "distress_ack_minus_support":v["distress-bare-ack"]-v["distress-support-topic"]} for g,v in groups.items()]
        write_jsonl(args.output/(name+"-scores.jsonl"),safe)
        report["splits"][name]=result
        print(json.dumps({"stage":name,"n":len(rows),"f1":result["f1"]}),flush=True)
    contrast=read_jsonl(args.contrast)
    rows=[{"relation":r["relation"],"context":[],"last_them":r["them"],"draft":r["draft"]} for r in contrast]
    scores=predictor.predict_batch(rows)
    report["contrast_alert_proxy"]=score_summary([int(r["alert"]) for r in contrast],scores,include_pr=False)
    report["contrast_alert_proxy"]["limitation"]="alert labels are not coldness ground truth; 16 rows / 8 pairs; fixed threshold; no tuning"
    by_pair=defaultdict(dict)
    for r,s in zip(contrast,scores):by_pair[r["pair"]][r["side"]]=s
    report["contrast_alert_proxy"]["group_score_deltas"]=[{"pair":g,"B_minus_A":v["B"]-v["A"]} for g,v in by_pair.items()]
    write_jsonl(args.output/"contrast-scores.jsonl",[{"pair":r["pair"],"side":r["side"],"alert_label":int(r["alert"]),
        "cold_score":s,"predicted_label":int(s>=.5)} for r,s in zip(contrast,scores)])
    write_json(args.output/"diagnosis.json",report)
    if args.source_root:
        write_json(args.output/"source-audit.json",source_audit(args.source_root,getattr(args,"queue_dir",None)))
    print(json.dumps({"status":"complete","output":str(args.output)}),flush=True)


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--checkpoint",type=Path,required=True)
    p.add_argument("--data",type=Path,required=True)
    p.add_argument("--contrast",type=Path,default=Path("eval/contrast_set.jsonl"))
    p.add_argument("--output",type=Path,required=True)
    p.add_argument("--source-root",type=Path)
    p.add_argument("--queue-dir",type=Path,help="PRIVATE server directory for unlabelled candidates; never export this directory")
    p.add_argument("--device",choices=["cpu","cuda"],default="cpu")
    run(p.parse_args())


if __name__=="__main__":main()
