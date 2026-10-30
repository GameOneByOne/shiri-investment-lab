import json
import unittest
from backend.official_catalogue import parse_sse,parse_bse,listing

class OfficialCatalogueTests(unittest.TestCase):
    def test_sse_count_guard_and_listing_date(self):
        row={'A_STOCK_CODE':'600000','SEC_NAME_CN':'浦发银行','LIST_DATE':'19991110'}
        payload={'result':[row],'pageHelp':{'total':1}}
        self.assertEqual(parse_sse(json.dumps(payload).encode())[0]['start'],'2021-01-01')
        payload['pageHelp']['total']=2
        with self.assertRaisesRegex(ValueError,'Incomplete'):parse_sse(json.dumps(payload).encode())

    def test_bse_exact_final_page_and_bad_wrapper(self):
        row={'xxzqdm':'920001','xxzqjc':'fixture','fxssrq':'20240102'}
        payload=[{'totalElements':101,'size':20,'totalPages':6,'number':5,'numberOfElements':1,'content':[row]}]
        rows,total,pages=parse_bse(('null('+json.dumps(payload)+')').encode(),5)
        self.assertEqual((total,pages,len(rows)),(101,6,1))
        with self.assertRaises(ValueError):parse_bse(b'<html>blocked</html>',5)
        with self.assertRaises(ValueError):listing('200001','B share','2024-01-02','sz')
        with self.assertRaises(ValueError):listing('600001','fixture','2024-02-30','sh')
