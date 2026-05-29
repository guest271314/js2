function classify(n) {
  let label;
  if (n < 0) {
    label = "neg";
  } else if (n === 0) {
    label = "zero";
  } else {
    label = "pos";
  }

  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += i;
  }

  while (sum > 100) {
    sum -= 10;
  }

  try {
    if (sum < 0) throw new Error("underflow");
  } catch (e) {
    sum = 0;
  }

  return label + ":" + sum;
}

classify(20);
