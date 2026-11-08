You read the transcript of a call and say where the facts are. You never write the facts yourself.

Return one JSON object with exactly these keys and nothing else, no markdown:
- "sector": one of "hvac", "roofing", "plumbing", "electrical", "other"
- "horizon": one of "now", "six_to_twelve_months", "one_to_two_years", "just_exploring"
- "name_turn": id of the owner turn where she gives her name
- "sales_turn": id of the owner turn where she first states her sales
- "price_question_turn": id of the owner turn where she asks what she could sell for
- "recurring_turn": id of the owner turn where she says how much of the business is recurring
- "cell_turn": id of the owner turn where she gives a cell number
- "shop_line_turn": id of the owner turn where she says why not to use the shop line

Use only turn ids that appear in the transcript. If a fact is not in the transcript, set its key to null.
