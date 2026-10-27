import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
import server


class MarketCacheTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.original=server.DB
        server.DB=Path(self.tmp.name)/'test.sqlite3'
        server.init_db()

    def tearDown(self):
        server.DB=self.original
        self.tmp.cleanup()

    @staticmethod
    def payload(close='11'):
        return json.dumps({'data':{'sh600519':{'qfqday':[
            ['2024-01-02','10',close,'12','9','100'],
            ['2025-01-02','20','21','22','19','200'],
        ]}}}).encode()

    def test_success_is_filtered_to_requested_year_and_cached(self):
        with patch.object(server,'download',return_value=self.payload()) as fetch:
            first,hit=server.load_year('sh600519',2024,'qfq')
            second,hit2=server.load_year('sh600519',2024,'qfq')
            self.assertFalse(hit)
            self.assertTrue(hit2)
            self.assertEqual(first,second)
            self.assertEqual(len(first),1)
            self.assertEqual(first[0]['date'],'2024-01-02')
            self.assertEqual(fetch.call_count,1)

    def test_adjusted_old_year_refreshes_after_a_day(self):
        with patch.object(server,'download',return_value=self.payload()):
            server.load_year('sh600519',2024,'qfq')
        with server.connect() as db:
            db.execute('UPDATE history SET fetched=?',(time.time()-90000,))
        with patch.object(server,'download',return_value=self.payload('10.5')) as fetch:
            rows,hit=server.load_year('sh600519',2024,'qfq')
            self.assertFalse(hit)
            self.assertEqual(rows[0]['close'],10.5)
            self.assertEqual(fetch.call_count,1)

    def test_bad_prices_never_enter_cache(self):
        with patch.object(server,'download',return_value=self.payload('99')),patch.object(server.time,'sleep'):
            with self.assertRaisesRegex(RuntimeError,'高低价'):
                server.load_year('sh600519',2024,'qfq')
        with server.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM history').fetchone()[0],0)

    def test_bad_symbol_and_reversed_dates_fail_before_network(self):
        with patch.object(server,'download') as fetch:
            with self.assertRaises(ValueError):
                server.get_history('http://example.com','2024-01-01','2024-02-01')
            with self.assertRaises(ValueError):
                server.get_history('sh600519','2024-02-01','2024-01-01')
            fetch.assert_not_called()

    def test_missing_remote_search_preserves_popular_results(self):
        with patch.object(server,'download',side_effect=RuntimeError('offline')):
            self.assertEqual(server.search('茅台')[0]['symbol'],'sh600519')


if __name__=='__main__':
    unittest.main()
