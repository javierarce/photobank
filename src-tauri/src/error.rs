use aws_sdk_s3::error::{ProvideErrorMetadata, SdkError};
use serde::{Serialize, Serializer};

/// Command errors cross the IPC boundary as their Display string, which the
/// frontend surfaces directly (see src/lib/api.ts).
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("database error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("{0}")]
    Message(String),
}

impl Error {
    pub fn msg(message: impl Into<String>) -> Self {
        Error::Message(message.into())
    }
}

/// AWS SDK errors `Debug`-print the entire request/response chain — raw XML
/// body, retry metadata, HTTP extensions — which is noise to a user. Reduce an
/// SDK error to a single readable sentence: the service's own message (with a
/// friendlier phrasing for the common, actionable codes), or a plain
/// description of a transport failure.
pub fn friendly_s3_error<E, R>(err: &SdkError<E, R>) -> String
where
    E: ProvideErrorMetadata,
{
    match err {
        SdkError::ServiceError(_) => match (err.code(), err.message()) {
            (Some("NoSuchBucket"), _) => "the bucket does not exist".to_string(),
            (Some("InvalidAccessKeyId"), _) => {
                "the access key ID is not recognized".to_string()
            }
            (Some("SignatureDoesNotMatch"), _) => {
                "the secret access key is incorrect".to_string()
            }
            (Some("AccessDenied") | Some("Forbidden"), _) => {
                "access denied — check the key's permissions".to_string()
            }
            (Some(code), Some(msg)) => format!("{msg} ({code})"),
            (Some(code), None) => code.to_string(),
            (None, Some(msg)) => msg.to_string(),
            (None, None) => "the service rejected the request".to_string(),
        },
        SdkError::TimeoutError(_) => "the request timed out".to_string(),
        // A transport failure's cause (DNS/TLS/connection-refused) is the whole
        // signal when an endpoint is mistyped, and — unlike a service error's
        // raw-response chain — it's a short sentence, so keep it.
        SdkError::DispatchFailure(cause) => match cause.as_connector_error() {
            Some(connector) => format!(
                "could not reach the endpoint ({}) — check the URL and your network",
                root_cause(connector)
            ),
            None => "could not reach the endpoint — check the URL and your network".to_string(),
        },
        SdkError::ResponseError(_) => "the server sent an unexpected response".to_string(),
        SdkError::ConstructionFailure(_) => "the request could not be built".to_string(),
        _ => "unexpected storage error".to_string(),
    }
}

/// The deepest message in an error's source chain — for transport errors this
/// is the concrete failure ("Connection refused", "dns error: …") rather than
/// the generic wrapper.
fn root_cause(err: &(dyn std::error::Error + 'static)) -> String {
    let mut cur: &dyn std::error::Error = err;
    while let Some(src) = cur.source() {
        cur = src;
    }
    cur.to_string()
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_s3::operation::list_objects_v2::ListObjectsV2Error;
    use aws_smithy_runtime_api::http::{Response, StatusCode};
    use aws_smithy_types::body::SdkBody;

    fn service_error(code: &str, message: &str, status: u16) -> SdkError<ListObjectsV2Error> {
        let err = ListObjectsV2Error::generic(
            aws_sdk_s3::error::ErrorMetadata::builder()
                .code(code)
                .message(message)
                .build(),
        );
        let raw = Response::new(StatusCode::try_from(status).unwrap(), SdkBody::empty());
        SdkError::service_error(err, raw)
    }

    #[test]
    fn common_codes_get_a_friendly_phrasing() {
        assert_eq!(
            friendly_s3_error(&service_error("NoSuchBucket", "The specified bucket does not exist", 404)),
            "the bucket does not exist"
        );
        assert_eq!(
            friendly_s3_error(&service_error("SignatureDoesNotMatch", "…", 403)),
            "the secret access key is incorrect"
        );
        assert_eq!(
            friendly_s3_error(&service_error("InvalidAccessKeyId", "…", 403)),
            "the access key ID is not recognized"
        );
        assert_eq!(
            friendly_s3_error(&service_error("AccessDenied", "…", 403)),
            "access denied — check the key's permissions"
        );
    }

    #[test]
    fn other_service_errors_keep_the_service_message() {
        assert_eq!(
            friendly_s3_error(&service_error("SlowDown", "Please reduce your request rate", 503)),
            "Please reduce your request rate (SlowDown)"
        );
    }

    #[test]
    fn transport_failures_read_plainly() {
        let timeout: SdkError<ListObjectsV2Error> = SdkError::timeout_error(Box::new(
            std::io::Error::new(std::io::ErrorKind::TimedOut, "request timed out"),
        ));
        assert_eq!(friendly_s3_error(&timeout), "the request timed out");
    }

    #[test]
    fn a_dispatch_failure_keeps_its_transport_cause() {
        // The mistyped-endpoint case: the connector's cause (DNS, connection
        // refused, TLS) is the useful signal and stays short, so surface it.
        use aws_smithy_runtime_api::client::result::ConnectorError;
        let io = std::io::Error::new(std::io::ErrorKind::ConnectionRefused, "Connection refused");
        let dispatch: SdkError<ListObjectsV2Error> =
            SdkError::dispatch_failure(ConnectorError::io(Box::new(io)));
        assert_eq!(
            friendly_s3_error(&dispatch),
            "could not reach the endpoint (Connection refused) — check the URL and your network"
        );
    }

    #[test]
    fn the_message_never_leaks_the_debug_chain() {
        // The bug this guards against: the whole SdkError Debug dump ending up
        // in the user-facing string.
        let msg = friendly_s3_error(&service_error(
            "NoSuchBucket",
            "The specified bucket does not exist",
            404,
        ));
        assert!(!msg.contains("ServiceError"));
        assert!(!msg.contains("SdkBody"));
        assert!(!msg.contains("raw:"));
    }
}
