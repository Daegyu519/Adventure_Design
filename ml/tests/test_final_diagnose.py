import pytest

from ml.final_diagnose import contains, score_summary, tags


def test_below_threshold_does_not_imply_bad_ranking():
    report=score_summary([0,0,1,1],[.1,.2,.3,.4])
    assert report["f1"]==0 and report["roc_auc_pairwise"]==1
    assert report["predicted_labels"]["1"]==0
    assert report["overlap"]["positive_fraction_in_negative_range"]==0
    assert len(report["diagnostic_pr_grid"])==19


def test_reversed_ranking_and_frozen_proxy_no_threshold_search():
    report=score_summary([0,0,1,1],[.8,.9,.1,.2],include_pr=False)
    assert report["roc_auc_pairwise"]==0
    assert "diagnostic_pr_grid" not in report
    assert report["class_metrics"]["1"]["recall"]==0


def test_lexical_tags_are_overlapping_screening_cues():
    found=tags({"relation":"", "last_them":"미안해, 힘들어서 도와줘"})
    assert {"apology","emotion","request","insufficient_metadata"}<=set(found)
    assert contains([1,2,3],[2,3]) and not contains([1,2],[2,3])
