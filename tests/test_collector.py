from datetime import date
from pathlib import Path
from unittest.mock import patch
import json
import tempfile
import unittest
from backend import collector


class CollectorTests(unittest.TestCase):
    def test_raw_close_only(self):
        rows = [['2024-01-02', 'invalid', '11', None, None, 'invalid']]
        self.assertEqual(collector.normalize(self.payload(rows), 'sh600519', 2024, '2024-12-31'),
                         [{'date': '2024-01-02', 'close': 11}])
        with self.assertRaises(ValueError):
            collector.normalize(self.payload(rows), 'sh600519', 2024, '2024-12-31', 'hfq')

    def payload(self, rows, key='day'):
        return {'code': 0, 'data': {'sh600519': {key: rows}}}

    def test_validate_sort_and_filter_year_and_future(self):
        result = collector.normalize(self.payload([
            ['2024-01-03', '10', '11', '12', '9'],
            ['2023-12-29', '10', '11', '12', '9'],
            ['2024-01-02', '10', '11', '12', '9'],
            ['2024-01-04', '10', '11', '12', '9'],
        ]), 'sh600519', 2024, '2024-01-03')
        self.assertEqual([r['date'] for r in result], ['2024-01-02', '2024-01-03'])

    def test_reject_raw_fallback_duplicates_invalid_prices(self):
        row = ['2024-01-02', '10', '11', '12', '9']
        with self.assertRaisesRegex(ValueError, 'day'):
            collector.normalize(self.payload([row], 'qfqday'), 'sh600519', 2024, '2024-12-31')
        for rows in ([row, row], [['2024-01-02', '10', '-1', '12', '9']],
                     [['2024-01-02', '10', 'NaN', '12', '9']]):
            with self.assertRaises(ValueError):
                collector.normalize(self.payload(rows), 'sh600519', 2024, '2024-12-31')

    def test_pool_has_benchmark_and_unique_symbols(self):
        pool = collector.load_pool()
        self.assertEqual(len(pool), 8)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'pool.json'
            path.write_text(json.dumps(pool + [pool[0]]), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, '重复'):
                collector.load_pool(path)

    def test_failed_year_never_publishes_partial_symbol(self):
        item = {'symbol': 'sh600519', 'start': '2023-01-01'}
        calls = []

        class Client:
            def rpc(self, name, params=None):
                calls.append((name, params))
                return 'run-id'

        def fail_second_year(symbol, year, end):
            if year == 2024:
                raise RuntimeError('offline')
            return [{'date': '2023-01-02', 'open': 10, 'close': 10, 'high': 10, 'low': 10}]

        with patch.object(collector.time, 'sleep'):
            errors = collector.run([item], Client(), '2024-12-31', fail_second_year)
        self.assertEqual(len(errors), 1)
        self.assertNotIn('market_publish', [name for name, _ in calls])
        self.assertEqual(calls[-1][0], 'market_run_finish')
        self.assertEqual(calls[-1][1]['p_succeeded'], 0)

    def test_complete_symbol_publishes_once(self):
        item = {'symbol': 'sh600519', 'start': '2024-01-01'}
        calls = []

        class Client:
            def rpc(self, name, params=None):
                calls.append((name, params))
                return 'run-id'

        bars = [{'date': '2024-01-02', 'open': 10, 'close': 10, 'high': 10, 'low': 10}]
        with patch.object(collector.time, 'sleep'):
            errors = collector.run([item], Client(), '2024-12-31', lambda *args: bars)
        self.assertFalse(errors)
        published = [p for name, p in calls if name == 'market_publish']
        self.assertEqual(published, [{'p_security': item, 'p_bars': bars}])


if __name__ == '__main__':
    unittest.main()

