from ml.context_ablation import context_ablation
from ml.tests.test_cold_data import group


def test_removal_really_removes_both_context_fields_and_does_not_invent_labels():
    class Fake:
        removed=0
        def predict(self,row,*,allow_empty=False):
            if allow_empty:
                assert row["context"]==[] and row["last_them"]=="" and row["relation"]=="친구"
                self.removed+=1
                return .3,0
            return (.9 if '시험' in row['last_them'] else .1),0
    fake=Fake()
    result=context_ablation(fake,group('validation'))
    assert fake.removed==3 and result['groups']==1
    assert result['rows'][0]['swapped_weak_label']==1
    assert result['rows'][1]['swapped_weak_label']==0
    assert result['rows'][2]['swapped_weak_label'] is None
