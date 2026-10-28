"""Small, validated row predicates for database imports; never executes user code."""
import math

from database_importers import _cell

OPERATORS = ('equals', 'not_equals', 'contains', 'in', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'not_empty')


def compile_filters(filters, fields):
    if filters is None:
        filters = []
    if not isinstance(filters, list) or len(filters) > 10:
        raise ValueError('Use an array of at most 10 filters (combined with AND).')
    predicates = []
    for rule in filters:
        if not isinstance(rule, dict) or rule.get('column') not in fields:
            raise ValueError('Filter columns must be chosen from the source fields.')
        column, op = rule['column'], rule.get('op', 'equals')
        if op not in OPERATORS:
            raise ValueError('Unsupported filter operator: ' + str(op))
        sensitive = rule.get('case_sensitive', False)
        if not isinstance(sensitive, bool):
            raise ValueError('case_sensitive must be a boolean.')
        normalize = lambda value, sensitive=sensitive: _cell(value) if sensitive else _cell(value).casefold()
        value = rule.get('value')
        if op == 'in':
            values = rule.get('values')
            if not isinstance(values, list) or not 1 <= len(values) <= 100:
                raise ValueError('An in filter needs 1 to 100 values.')
            target = {normalize(item) for item in values}
        elif op in ('gt', 'gte', 'lt', 'lte'):
            try:
                target = float(value)
                if isinstance(value, bool) or not math.isfinite(target): raise ValueError()
            except (TypeError, ValueError, OverflowError) as error:
                raise ValueError('Numeric filters require a finite numeric value.') from error
        elif op not in ('is_empty', 'not_empty'):
            if 'value' not in rule or isinstance(value, (list, dict)):
                raise ValueError('This filter requires a single value.')
            target = normalize(value)
        else:
            target = None
        def matches(record, column=column, op=op, target=target, normalize=normalize):
            raw = record.get(column)
            text = normalize(raw)
            if op == 'is_empty': return text.strip() == ''
            if op == 'not_empty': return text.strip() != ''
            if op == 'equals': return text == target
            if op == 'not_equals': return text != target
            if op == 'contains': return target in text
            if op == 'in': return text in target
            try:
                number = float(raw)
                if isinstance(raw, bool) or not math.isfinite(number): return False
            except (TypeError, ValueError, OverflowError):
                return False
            return {'gt': number > target, 'gte': number >= target, 'lt': number < target, 'lte': number <= target}[op]
        predicates.append(matches)
    return lambda record: all(predicate(record) for predicate in predicates)
