from datetime import date
from pathlib import Path
from unittest.mock import patch
import json
import tempfile
import unittest
from backend import collector


class CollectorTests(unittest.TestCase):
    def test_explicit_hfq_and_trading_statistics(self):
        rows = [['2024-01-02', '10', '11', '12', '9', '123', {}, '.2', '456']]
        payload = self.payload(rows, 'hfqday')
        bar = collector.normalize(payload, 'sh600519', 2024, '2024-12-31', 'hfq')[0]
        self.assertEqual(bar['volumeRaw'], 123)
        self.assertEqual(bar['amountCny'], 4560000)
        self.assertEqual(bar['turnoverRate'], .002)
        with self.assertRaisesRegex(ValueError, 'qfqday'):
            collector.normalize(payload, 'sh600519', 2024, '2024-12-31')

    def payload(self, rows, key='qfqday'):
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
        with self.assertRaisesRegex(ValueError, 'qfqday'):
            collector.normalize(self.payload([row], 'day'), 'sh600519', 2024, '2024-12-31')
        for rows in ([row, row], [['2024-01-02', '10', '99', '12', '9']],
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


