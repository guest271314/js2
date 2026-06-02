function add(a, b = 10) {
  return a + b;
}

const square = (n) => n * n;

const compose = (f, g) => (x) => f(g(x));

add(square(2), 3);
