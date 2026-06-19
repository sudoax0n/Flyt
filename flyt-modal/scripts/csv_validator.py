import pandas as pd
import numpy as np
import argparse
import sys

def calculate_rmse(y_true, y_pred):
    return np.sqrt(np.mean((y_true - y_pred) ** 2))

def main():
    parser = argparse.ArgumentParser(description="Flyt CSV Parity Validator")
    parser.add_argument("--candidate", required=True, help="Path to candidate CSV file")
    parser.add_argument("--gold", required=True, help="Path to gold reference CSV file")
    args = parser.parse_args()

    print(f"Loading candidate: {args.candidate}")
    print(f"Loading gold reference: {args.gold}")

    try:
        cand_df = pd.read_csv(args.candidate)
        gold_df = pd.read_csv(args.gold)
    except Exception as e:
        print(f"Error loading CSV files: {e}")
        sys.exit(1)

    if len(cand_df) != len(gold_df):
        print(f"FAIL: Row count mismatch. Candidate has {len(cand_df)} rows, Gold has {len(gold_df)} rows.")
        sys.exit(1)

    coords = ["fly1_x", "fly1_y", "fly2_x", "fly2_y"]
    errors = {}
    pass_gate = True

    print("\nCalculating RMSE for coordinate columns:")
    print("-----------------------------------------")
    for col in coords:
        if col not in cand_df.columns:
            print(f"FAIL: Column '{col}' missing from candidate CSV.")
            sys.exit(1)
        if col not in gold_df.columns:
            print(f"FAIL: Column '{col}' missing from gold CSV.")
            sys.exit(1)

        rmse = calculate_rmse(gold_df[col].values, cand_df[col].values)
        errors[col] = rmse
        print(f"  {col}: {rmse:.4f} px")
        if rmse >= 2.0:
            pass_gate = False

    print("-----------------------------------------")
    if pass_gate:
        print("SUCCESS: All coordinates are within parity limits (RMSE < 2.0 px)!")
        sys.exit(0)
    else:
        print("FAIL: One or more coordinate columns exceed the 2.0 px RMSE parity limit.")
        sys.exit(1)

if __name__ == "__main__":
    main()
