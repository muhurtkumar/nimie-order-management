import {useState} from "react";
import {useFetcher, useLoaderData} from "react-router";
import {boundary} from "@shopify/shopify-app-react-router/server";
import {authenticate} from "../shopify.server"

const RETURN_NAMESPACE = "custom";
const RETURN_KEY = "return_requests";

const ALLOWED_STATUSES = [
  "Pending review",
  "Approved",
  "Rejected",
];

const ORDERS_QUERY = `#graphql
  query ReturnRequestsDashboard {
    orders(first: 50, sortKey: CREATED_AT, reverse: true) {
      nodes {
        id
        name
        createdAt
        customer {
          displayName
          email
        }
        metafield(namespace: "custom", key: "return_requests") {
          value
        }
      }
    }
  }
`;

const ORDER_RETURN_REQUEST_QUERY = `#graphql
  query GetOrderReturnRequests($id: ID!) {
    order(id: $id) {
      id
      name
      metafield(namespace: "custom", key: "return_requests") {
        value
      }
    }
  }
`;

const UPDATE_RETURN_REQUEST_MUTATION = `#graphql
  mutation UpdateReturnRequests($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        namespace
        key
        value
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

function parseReturnRequests(value) {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function formatDate(value) {
  if (!value) return "—";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "—";

  return date.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getStatusStyle(status) {
  switch (status) {
    case "Approved":
      return {
        background: "#dcfce7",
        color: "#166534",
      };

    case "Rejected":
      return {
        background: "#fee2e2",
        color: "#991b1b",
      };

    default:
      return {
        background: "#fef3c7",
        color: "#92400e",
      };
  }
}

export const loader = async ({request}) => {
  const {admin} = await authenticate.admin(request);

  const response = await admin.graphql(ORDERS_QUERY);
  const result = await response.json();

  if (result.errors?.length) {
    console.error("Return requests GraphQL error:", result.errors);

    throw new Response("Could not load return requests from Shopify.", {
      status: 500,
    });
  }

  const orders = result.data?.orders?.nodes ?? [];

  const returnRequests = [];
  let invalidMetafieldCount = 0;

  for (const order of orders) {
    const metafieldValue = order.metafield?.value;

    if (!metafieldValue) continue;

    let parsedRequests;

    try {
      parsedRequests = JSON.parse(metafieldValue);

      if (!Array.isArray(parsedRequests)) {
        throw new Error("Return requests metafield is not an array.");
      }
    } catch {
      invalidMetafieldCount += 1;
      continue;
    }

    for (const request of parsedRequests) {
      returnRequests.push({
        id: request.id ?? "",
        orderId: order.id,
        orderName: order.name,
        orderCreatedAt: order.createdAt,
        customerName: order.customer?.displayName || "Guest customer",
        customerEmail: order.customer?.email || "",
        lineItemId: request.lineItemId ?? "",
        title: request.title || "Product",
        variantTitle: request.variantTitle || "",
        quantity: request.quantity ?? 1,
        reason: request.reason || "Not provided",
        description: request.description || "",
        status: request.status || "Pending review",
        requestedAt: request.requestedAt || order.createdAt,
      });
    }
  }

  return {
    returnRequests: returnRequests.sort(
      (a, b) =>
        new Date(b.requestedAt).getTime() -
        new Date(a.requestedAt).getTime(),
    ),
    ordersChecked: orders.length,
    invalidMetafieldCount,
  };
};

export const action = async ({request}) => {
  const {admin} = await authenticate.admin(request);

  const formData = await request.formData();

  const orderId = formData.get("orderId");
  const requestId = formData.get("requestId");
  const newStatus = formData.get("status");

  if (
    typeof orderId !== "string" ||
    !orderId.startsWith("gid://shopify/Order/") ||
    typeof requestId !== "string" ||
    !requestId ||
    typeof newStatus !== "string" ||
    !ALLOWED_STATUSES.includes(newStatus)
  ) {
    return {
      success: false,
      error: "Invalid return request or status.",
    };
  }

  // Fetch the latest metafield value before updating it.
  const orderResponse = await admin.graphql(
    ORDER_RETURN_REQUEST_QUERY,
    {
      variables: {id: orderId},
    },
  );

  const orderResult = await orderResponse.json();

  if (orderResult.errors?.length) {
    console.error("Order lookup error:", orderResult.errors);

    return {
      success: false,
      error: "Could not retrieve this order from Shopify.",
    };
  }

  const order = orderResult.data?.order;

  if (!order) {
    return {
      success: false,
      error: "Order not found.",
    };
  }

  const metafieldValue = order.metafield?.value;

  if (!metafieldValue) {
    return {
      success: false,
      error: "This order has no return requests.",
    };
  }

  let requests;

  try {
    requests = JSON.parse(metafieldValue);

    if (!Array.isArray(requests)) {
      throw new Error("Invalid return requests format.");
    }
  } catch {
    return {
      success: false,
      error: "The order's return requests could not be read.",
    };
  }

  const targetRequest = requests.find((item) => item.id === requestId);

  if (!targetRequest) {
    return {
      success: false,
      error: "Return request not found. Refresh the dashboard and try again.",
    };
  }

  // Do not change any other return requests on this order.
  targetRequest.status = newStatus;

  const saveResponse = await admin.graphql(
    UPDATE_RETURN_REQUEST_MUTATION,
    {
      variables: {
        metafields: [
          {
            ownerId: orderId,
            namespace: RETURN_NAMESPACE,
            key: RETURN_KEY,
            type: "json",
            value: JSON.stringify(requests),
          },
        ],
      },
    },
  );

  const saveResult = await saveResponse.json();

  if (saveResult.errors?.length) {
    console.error("Metafield update error:", saveResult.errors);

    return {
      success: false,
      error: "Shopify could not save the updated status.",
    };
  }

  const userErrors =
    saveResult.data?.metafieldsSet?.userErrors ?? [];

  if (userErrors.length) {
    console.error("Metafield user errors:", userErrors);

    return {
      success: false,
      error: userErrors.map((item) => item.message).join(" "),
    };
  }

  return {
    success: true,
    message: `${order.name}: return request marked as ${newStatus}.`,
  };
};

export default function ReturnRequestsDashboard() {
  const {returnRequests, ordersChecked, invalidMetafieldCount} =
    useLoaderData();

  const fetcher = useFetcher();

  const isUpdating =
    fetcher.state === "submitting" || fetcher.state === "loading";

  const [filterStatus, setFilterStatus] = useState("All");

  const filteredRequests =
    filterStatus === "All"
      ? returnRequests
      : returnRequests.filter(
          (request) => request.status === filterStatus,
        );

  const pendingCount = returnRequests.filter(
    (request) => request.status === "Pending review",
  ).length;

  const approvedCount = returnRequests.filter(
    (request) => request.status === "Approved",
  ).length;

  const rejectedCount = returnRequests.filter(
    (request) => request.status === "Rejected",
  ).length;

  const updateResult = fetcher.data;

  return (
    <s-page heading="Return Requests">
      <s-section>
        <s-paragraph>
          Review customer return requests submitted through the Nimie
          customer account.
        </s-paragraph>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
            gap: "16px",
            marginTop: "20px",
          }}
        >
          <SummaryCard
            label="Total requests"
            value={returnRequests.length}
          />
          <SummaryCard
            label="Pending review"
            value={pendingCount}
          />
          <SummaryCard label="Approved" value={approvedCount} />
          <SummaryCard label="Rejected" value={rejectedCount} />
        </div>
      </s-section>

      {updateResult?.message && (
        <s-section>
          <s-banner tone="success">{updateResult.message}</s-banner>
        </s-section>
      )}

      {updateResult?.error && (
        <s-section>
          <s-banner tone="critical">{updateResult.error}</s-banner>
        </s-section>
      )}

      {invalidMetafieldCount > 0 && (
        <s-section>
          <s-banner tone="warning">
            {invalidMetafieldCount} order(s) contained return-request
            data that could not be read. Check the metafield JSON.
          </s-banner>
        </s-section>
      )}

      <s-section heading="Customer return requests">
        <div style={{marginBottom: "16px"}}>
          <label
            htmlFor="return-status-filter"
            style={{
              display: "block",
              fontWeight: 600,
              marginBottom: "6px",
            }}
          >
            Filter by status
          </label>

          <select
            id="return-status-filter"
            value={filterStatus}
            onChange={(event) => setFilterStatus(event.target.value)}
            style={{
              padding: "9px 12px",
              border: "1px solid #c9cccf",
              borderRadius: "8px",
              background: "#fff",
              minWidth: "220px",
            }}
          >
            <option value="All">All requests</option>
            <option value="Pending review">Pending review</option>
            <option value="Approved">Approved</option>
            <option value="Rejected">Rejected</option>
          </select>
        </div>

        {filteredRequests.length === 0 ? (
          <s-banner tone="info">
            {returnRequests.length === 0
              ? `No return requests were found in the ${ordersChecked} most recently created orders checked.`
              : "No requests match the selected status."}
          </s-banner>
        ) : (
          <div style={{overflowX: "auto"}}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "13px",
                textAlign: "left",
              }}
            >
              <thead>
                <tr style={{background: "#f6f6f7"}}>
                  {[
                    "Order",
                    "Customer",
                    "Product",
                    "Qty",
                    "Reason",
                    "Requested",
                    "Status",
                    "Actions",
                  ].map((heading) => (
                    <th
                      key={heading}
                      style={{
                        padding: "12px",
                        borderBottom: "1px solid #e1e3e5",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {filteredRequests.map((item) => (
                  <tr key={`${item.orderId}-${item.id}`}>
                    <td style={cellStyle}>
                      <a
                        href={`shopify://admin/orders/${item.orderId.split("/").pop()}`}
                        target="_top"
                        style={{
                          color: "#005bd3",
                          fontWeight: 600,
                          textDecoration: "none",
                        }}
                      >
                        {item.orderName}
                      </a>
                    </td>

                    <td style={cellStyle}>
                      <div style={{fontWeight: 600}}>
                        {item.customerName}
                      </div>
                      {item.customerEmail && (
                        <div style={{color: "#616161", marginTop: "4px"}}>
                          {item.customerEmail}
                        </div>
                      )}
                    </td>

                    <td style={{...cellStyle, minWidth: "160px"}}>
                      <div style={{fontWeight: 600}}>{item.title}</div>
                      {item.variantTitle && (
                        <div style={{color: "#616161", marginTop: "4px"}}>
                          {item.variantTitle}
                        </div>
                      )}
                      {item.description && (
                        <details style={{marginTop: "6px"}}>
                          <summary style={{cursor: "pointer"}}>
                            Customer notes
                          </summary>
                          <div
                            style={{
                              whiteSpace: "pre-wrap",
                              marginTop: "6px",
                              maxWidth: "250px",
                            }}
                          >
                            {item.description}
                          </div>
                        </details>
                      )}
                    </td>

                    <td style={cellStyle}>{item.quantity}</td>

                    <td style={{...cellStyle, minWidth: "130px"}}>
                      {item.reason}
                    </td>

                    <td style={{...cellStyle, minWidth: "145px"}}>
                      {formatDate(item.requestedAt)}
                    </td>

                    <td style={cellStyle}>
                      <span
                        style={{
                          ...getStatusStyle(item.status),
                          display: "inline-block",
                          borderRadius: "20px",
                          padding: "5px 9px",
                          fontWeight: 600,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {item.status}
                      </span>
                    </td>

                    <td style={{...cellStyle, minWidth: "150px"}}>
                      <fetcher.Form method="post">
                        <input
                          type="hidden"
                          name="orderId"
                          value={item.orderId}
                        />
                        <input
                          type="hidden"
                          name="requestId"
                          value={item.id}
                        />

                        <select
                          name="status"
                          defaultValue={item.status}
                          aria-label={`New status for ${item.orderName} ${item.title}`}
                          style={{
                            width: "100%",
                            padding: "7px",
                            border: "1px solid #c9cccf",
                            borderRadius: "6px",
                            marginBottom: "8px",
                          }}
                        >
                          {ALLOWED_STATUSES.map((status) => (
                            <option key={status} value={status}>
                              {status}
                            </option>
                          ))}
                        </select>

                        <button
                          type="submit"
                          disabled={isUpdating}
                          style={{
                            padding: "8px 12px",
                            border: "none",
                            borderRadius: "6px",
                            background: "#303030",
                            color: "#fff",
                            cursor: isUpdating ? "wait" : "pointer",
                            opacity: isUpdating ? 0.6 : 1,
                          }}
                        >
                          {isUpdating ? "Saving..." : "Save status"}
                        </button>
                      </fetcher.Form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div style={{marginTop: "16px", color: "#616161"}}>
          Checked the {ordersChecked} most recently created orders. Shopify
          pagination can be added if you need to search older orders.
        </div>
      </s-section>
    </s-page>
  );
}

const cellStyle = {
  padding: "12px",
  borderBottom: "1px solid #e1e3e5",
  verticalAlign: "top",
};

function SummaryCard({label, value}) {
  return (
    <div
      style={{
        padding: "18px",
        border: "1px solid #e1e3e5",
        borderRadius: "12px",
        background: "#fff",
      }}
    >
      <div style={{fontSize: "13px", color: "#616161"}}>{label}</div>
      <div style={{fontSize: "28px", fontWeight: 700, marginTop: "8px"}}>
        {value}
      </div>
    </div>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};