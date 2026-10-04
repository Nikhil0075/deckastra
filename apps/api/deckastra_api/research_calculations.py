"""Bounded arithmetic from CSV records, independent of model-generated claims."""
import csv
import io
import re
from collections import defaultdict
from decimal import Decimal, InvalidOperation, localcontext


def csv_growth(sources):
    results = []
    for source in sources:
        if source.get("mime_type") != "text/csv" and not str(source.get("title", "")).lower().endswith(".csv"):
            continue
        reader = csv.DictReader(io.StringIO(source["text"]))
        fields = reader.fieldnames or []
        time = next((f for f in fields if f.lower() in {"quarter", "year", "period", "date"}), None)
        measures = [f for f in fields if f.lower().startswith("revenue")]
        if not time or not measures:
            continue
        group = next((f for f in fields if f.lower() in {"region", "country", "segment"}), None)
        groups = defaultdict(list)
        for index, row in enumerate(reader):
            if index >= 1000: break
            # Comments, truncated lines and instructions outside records are data,
            # never a replacement for a numeric cell.
            if None in row or any(row.get(f) is None for f in fields): continue
            groups[str(row.get(group, "All records"))].append(row)
        for name, rows in groups.items():
            labels = [row[time] for row in rows]
            # Only a verified increasing quarter/year sequence is interpreted as time.
            sequence = [re.fullmatch(r"Q([1-4])", label) for label in labels]
            ordered = all(sequence) and all(int(sequence[i][1]) < int(sequence[i + 1][1]) for i in range(len(sequence) - 1))
            ordered = ordered or all(re.fullmatch(r"\d{4}", label) for label in labels) and labels == sorted(set(labels))
            if len(rows) < 2 or not ordered: continue
            for field in measures:
                try:
                    if any(len(row[field]) > 64 for row in rows): continue
                    values = [Decimal(row[field]) for row in rows]
                except InvalidOperation:
                    continue
                if not all(v.is_finite() and abs(v.as_tuple().exponent) <= 12 and len(v.as_tuple().digits) <= 24 for v in values) or values[0] <= 0: continue
                with localcontext() as context:
                    context.prec = 80
                    growth = (values[-1] - values[0]) / values[0] * 100
                    results.append({"source_id": source["id"], "group": name, "measure": field, "first_period": labels[0], "last_period": labels[-1], "first_value": str(values[0]), "last_value": str(values[-1]), "period_total": str(sum(values)), "growth_percent": str(growth.quantize(Decimal(".01"))), "method": "(last - first) / first × 100; first-to-last period growth, not year-over-year"})
    return results[:100]


def describe(calculations):
    """One line per calculation, in words that say what kind of growth it is.

    The arithmetic is exact, and the label is where it went wrong: a generated
    slide called Q1-to-Q4 growth "YoY" because generation saw raw CSV rows and
    guessed. Research and generation share these lines so the two cannot differ.
    """
    return "\n".join(
        f"[{c['source_id']}] {c['group']} · {c['measure']}: {c['first_period']} {c['first_value']} → {c['last_period']} {c['last_value']}; "
        f"growth from {c['first_period']} to {c['last_period']} was {c['growth_percent']}%; period total {c['period_total']}. "
        f"This is first-to-last growth within one period, not year-over-year growth: call it \"{c['first_period']} to {c['last_period']}\", never \"YoY\"."
        for c in calculations
    )


def calculation_source(calculations):
    """The checked arithmetic as a generation source, cited like any other."""
    return {"id": "csv-calculations", "kind": "calculation", "title": "Checked CSV arithmetic",
            "text": "Computed by Deckastra from the numeric CSV records, not by a model.\n" + describe(calculations)}
