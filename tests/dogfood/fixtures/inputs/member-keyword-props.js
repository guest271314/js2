// #3033 — reserved words as property names after `.` (acorn parseIdent(liberal)
// path) + the chained `this.type.keyword` read that Bug 2b truncated to null.
x.var;
x.var = [];
x.function;
x.if;
x.foo = [];
function S(f) {
  this.var = [];
}
x.type.keyword;
